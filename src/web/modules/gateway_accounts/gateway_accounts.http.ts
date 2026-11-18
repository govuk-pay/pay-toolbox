import {NextFunction, Request, Response} from 'express'
import {stringify} from 'qs'
import moment from 'moment'
import {capitalize} from "lodash"

import logger from '../../../lib/logger'

import {AdminUsers, Connector, Products, PublicAuth} from '../../../lib/pay-request/client'
import {wrapAsyncErrorHandler} from '../../../lib/routes'
import {extractFiltersFromQuery, toAccountSearchParams} from '../../../lib/gatewayAccounts'

import GatewayAccountFormModel from './gatewayAccount.model'
import {GoLiveStage, Service, UpdateServiceRequest} from '../../../lib/pay-request/services/admin_users/types'
import {ProductType} from '../../../lib/pay-request/services/products/types'
import {GatewayAccount, NotifySettings, StripeCredentials} from '../../../lib/pay-request/services/connector/types'
import {PaymentProvider} from '../../../lib/pay-request/shared'
import {ClientFormError} from '../common/validationErrorFormat'
import * as config from '../../../config'
import {format} from './csv'
import {formatWithAdminEmails} from './csv_with_admin_emails'
import {createCsvData, createCsvWithAdminEmailsData} from './csv_data'
import {EntityNotFoundError, ValidationError} from '../../../lib/errors'

import * as stripeClient from '../../../lib/stripe/stripe.client'
import {
  getTicket,
  updateTicketWithStripeGoLiveResponse,
  updateTicketWithWorldpayGoLiveResponse
} from "../../../lib/zendesk/zendesk.client";
import Joi from "joi";
import {TokenState} from "../../../lib/pay-request/services/public_auth/types";

const NOTIFY_ID_PATTERN = /^[a-zA-Z0-9-]*$/

async function overview(req: Request, res: Response): Promise<void> {
  const filters = extractFiltersFromQuery(req.query)
  const searchParams = toAccountSearchParams(filters)

  const {accounts} = await Connector.accounts.list(searchParams)

  res.render('gateway_accounts/overview', {
    card: true,
    accounts,
    messages: req.flash('info'),
    filters,
    total: accounts.length.toLocaleString(),
    csvUrl: `gateway_accounts/csv?${stringify(filters)}`,
    csvWithAdminEmailsUrl: `gateway_accounts/csvWithAdminEmails?${stringify(filters)}`
  })
}

async function listCSVWithAdminEmails(req: Request, res: Response): Promise<void> {
  const filters = extractFiltersFromQuery(req.query)
  const data = await createCsvWithAdminEmailsData(filters)
  res.set('Content-Type', 'text/csv')
  res.set('Content-Disposition', `attachment; filename="GOVUK_Pay_gateway_accounts_with_admin_emails_${stringify(filters)}.csv"`)
  res.status(200).send(formatWithAdminEmails(data))
}

async function listCSV(req: Request, res: Response): Promise<void> {
  const filters = extractFiltersFromQuery(req.query)
  const data = await createCsvData(filters)
  res.set('Content-Type', 'text/csv')
  res.set('Content-Disposition', `attachment; filename="GOVUK_Pay_gateway_accounts_${stringify(filters)}.csv"`)
  res.status(200).send(format(data))
}

interface CreateGatewayAccountPageData {
  linkedCredentials: string;
  live: string;
  provider: string;
  recovered?: object;
  service?: Service;
  description?: string;
  flash: object;
  errors?: ClientFormError[];
  errorMap?: object;
  csrf: string;
}

async function create(req: Request, res: Response): Promise<void> {
  const serviceId = req.query.service as string
  const live = req.query.live as string
  const provider = req.query.provider as string

  if (!live || !provider) {
    throw new Error('Expected "live" and "provider" query parameters')
  }

  const context: CreateGatewayAccountPageData = {
    linkedCredentials: req.query.credentials as string,
    live,
    provider,
    flash: req.flash(),
    csrf: req.csrfToken()
  }

  const {recovered} = req.session
  if (recovered) {
    context.recovered = recovered.formValues

    if (recovered.errors) {
      context.errors = recovered.errors
      context.errorMap = recovered.errors.reduce((aggregate: {
        [key: string]: string;
      }, error: ClientFormError) => {
        aggregate[error.id] = error.message
        return aggregate
      }, {})
    }
    delete req.session.recovered
  }

  if (serviceId) {
    const service = await AdminUsers.services.retrieve(serviceId)
    context.service = service
    if (!service.merchant_details?.name) {
      req.flash('info','Organisation name is required to create a new gateway account')
      res.redirect(`/services/${serviceId}/organisation`)
    }
    context.description = `${service.merchant_details.name} ${service.name} ${capitalize(provider)} ${live === 'live' && 'LIVE' || 'TEST'}`
  }
  res.render('gateway_accounts/create', context)
}

async function confirm(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const account = new GatewayAccountFormModel(req.body)
    res.render('gateway_accounts/confirm', {account, request: req.body, csrf: req.csrfToken()})
  } catch (error) {
    next(error)
  }
}

function getGoLiveUrlForService(gatewayAccountExternalId: string) {
  return `${config.services.SELFSERVICE_URL}/account/${gatewayAccountExternalId}/dashboard`
}

async function writeAccount(req: Request, res: Response): Promise<void> {
  const account = new GatewayAccountFormModel(req.body)

  let ticket;
  if (req.body.zendeskTicketNumber) {
    ticket = await getTicket(req.body.zendeskTicketNumber)
  }

  const serviceId = req.body.systemLinkedService
  account.serviceId = serviceId

  const createdAccount = await Connector.accounts.create(account.formatPayload())
  const gatewayAccountIdDerived = String(createdAccount.gateway_account_id)

  logger.info(`Created new Gateway Account ${gatewayAccountIdDerived}`)

  // connect system linked services to the created account
  if (serviceId) {
    const service = await AdminUsers.services.retrieve(serviceId)
    const isUpdateServiceToLive = account.isLive() && service.current_go_live_stage !== 'LIVE'
    const serviceUpdateRequest: UpdateServiceRequest = {
      gateway_account_ids: [gatewayAccountIdDerived],
      internal: account.internalFlag,
      sector: account.sector
    }
    if (isUpdateServiceToLive) {
      serviceUpdateRequest.current_go_live_stage = GoLiveStage.Live
      serviceUpdateRequest.went_live_date = moment.utc().format()
    }
    await AdminUsers.services.update(serviceId, serviceUpdateRequest)
    logger.info(`Service ${serviceId} linked to new Gateway Account ${gatewayAccountIdDerived}`)

    logger.info('Service made live', {
      service_name: service.service_name.en,
      organisation_name: service.merchant_details && service.merchant_details.name,
      sector: account.sector,
      service_went_live_date: moment.utc().format(),
      service_created_date: moment.utc(service.created_date).format(),
      service_using_provider: account.provider,
      service_is_internal_service: account.internalFlag
    })
  }

  const stripeAccountStatementDescriptors: {
    payoutStatementDescriptor?: string,
    statementDescriptor?: string
  } = {}

  if (account.provider === PaymentProvider.Stripe) {
    const stripeAccountDetails = await stripeClient.getStripeApi(account.isLive()).accounts.retrieve(account.credentials)
    stripeAccountStatementDescriptors.payoutStatementDescriptor = stripeAccountDetails.settings.payouts.statement_descriptor
    stripeAccountStatementDescriptors.statementDescriptor = stripeAccountDetails.settings.payments.statement_descriptor
  }

  let zendeskTicketUpdated = false
  if (account.provider === PaymentProvider.Worldpay && ticket) {
    zendeskTicketUpdated = await updateTicketWithWorldpayGoLiveResponse(ticket, getGoLiveUrlForService(createdAccount.external_id));
  } else if (account.provider === PaymentProvider.Stripe && ticket) {
    zendeskTicketUpdated = await updateTicketWithStripeGoLiveResponse(ticket, getGoLiveUrlForService(createdAccount.external_id),
      stripeAccountStatementDescriptors.statementDescriptor, stripeAccountStatementDescriptors.payoutStatementDescriptor);
  }

  // note payment_provider is not returned in the object returned from createAccount
  res.render('gateway_accounts/createSuccess', {
    account: createdAccount,
    linkedService: serviceId,
    gatewayAccountIdDerived,
    provider: account.provider,
    isLive: account.isLive(),
    isStripe: account.provider === 'stripe',
    zendeskTicketUpdated: zendeskTicketUpdated,
    stripeAccountStatementDescriptors,
    selfServiceBaseUrl: config.services.SELFSERVICE_URL
  })
}

async function detail(req: Request, res: Response): Promise<void> {

  let stripeDashboardUri = ''

  const {id} = req.params
  const [account, acceptedCards, stripeSetup, motoProducts, activeTokens, revokedTokens] = await Promise.all([
    Connector.accounts.retrieve(id),
    Connector.accounts.listCardTypes(id),
    Connector.accounts.retrieveStripeSetup(id),
    Products.accounts.listProductsByType(id, ProductType.Moto),
    PublicAuth.tokens.list({ gateway_account_id: id, token_state: TokenState.Active }),
    PublicAuth.tokens.list({ gateway_account_id: id, token_state: TokenState.Revoked })
  ])

  let service = {}
  try {
    service = await AdminUsers.services.retrieveByGatewayAccountId(id)
  } catch (error: any) {
    logger.warn(`Services request for gateway account ${id} returned "${error.message}"`)
  }

  let stripePaymentsStatementDescriptor, stripePayoutsStatementDescriptor
  try {
    if (account.payment_provider === 'stripe') {
      const {stripe_account_id} = await Connector.accounts.retrieveStripeCredentials(id)
      const stripeAccount = await stripeClient.getStripeApi(account.live).accounts.retrieve(stripe_account_id)
      stripePaymentsStatementDescriptor = stripeAccount.settings.payments.statement_descriptor
      stripePayoutsStatementDescriptor = stripeAccount.settings.payouts.statement_descriptor
    }
    /* eslint-disable @typescript-eslint/no-unused-vars */
  } catch (error) {
    logger.warn('Unable to retrieve account details from Stripe. Make sure the Stripe API key is configured in the environment variables')
  }

  const currentCredential = getCurrentCredential(account)

  const outstandingStripeSetupTasks = Object.keys(stripeSetup)
    .filter(task => task != 'organisation_details' && stripeSetup[task] === false)
    .map(task => task.replace(/_/g, " "))

  if (currentCredential && currentCredential.payment_provider === PaymentProvider.Stripe) {
    const stripeCredentials = currentCredential.credentials as StripeCredentials
    stripeDashboardUri = `https://dashboard.stripe.com/${account.live ? '' : 'test/'}connect/accounts/${stripeCredentials.stripe_account_id}`
  }

  const is3DSFlexApplicable = (currentCredential.payment_provider === PaymentProvider.Worldpay && !account.allow_moto)
  const threeDSFlexEnabled = (account.integration_version_3ds === 2)
  const motoPaymentLinkExists = motoProducts.length > 0
  const corporateSurchargeEnabled = account.corporate_credit_card_surcharge_amount ||
    account.corporate_debit_card_surcharge_amount || account.corporate_prepaid_debit_card_surcharge_amount

  res.render('gateway_accounts/detail', {
    account,
    acceptedCards,
    gatewayAccountId: id,
    services: service,
    currentCredential,
    outstandingStripeSetupTasks,
    stripeDashboardUri,
    is3DSFlexApplicable,
    threeDSFlexEnabled,
    motoPaymentLinkExists,
    corporateSurchargeEnabled,
    activeTokensCount: activeTokens.tokens.length,
    revokedTokensCount: revokedTokens.tokens.length,
    stripePaymentsStatementDescriptor,
    stripePayoutsStatementDescriptor,
    messages: req.flash('info'),
    csrf: req.csrfToken()
  })
}

function getCurrentCredential(account: GatewayAccount) {
  const credentials = account.gateway_account_credentials || []
  return credentials.find(credential => credential.state === 'ACTIVE') || credentials[0]
}

async function apiKeys(req: Request, res: Response): Promise<void> {
  const gatewayAccountId = req.params.id

  const account = await getAccount(gatewayAccountId)
  const tokensResponse = await PublicAuth.tokens.list({ gateway_account_id: gatewayAccountId, token_state: TokenState.Active })

  res.render('gateway_accounts/api_keys', {
    account,
    tokens: tokensResponse.tokens,
    gatewayAccountId,
    messages: req.flash('info')
  })
}

async function revokedApiKeys (req: Request, res: Response): Promise<void> {
  const gatewayAccountId = req.params.id

  const account = await getAccount(gatewayAccountId)
  const tokensResponse = await PublicAuth.tokens.list({ gateway_account_id: gatewayAccountId, token_state: TokenState.Revoked })

  res.render('gateway_accounts/revoked_api_keys', {
    account,
    tokens: tokensResponse.tokens,
    gatewayAccountId
  })
}

async function deleteApiKey(req: Request, res: Response): Promise<void> {
  const {accountId, tokenId} = req.params

  await PublicAuth.tokens.delete({gateway_account_id: accountId, token_link: tokenId})
  logger.info(`Revoked API Token with token_link ${tokenId} for Gateway Account ${accountId}`)

  req.flash('info', `Token ${tokenId} successfully revoked`)
  res.redirect(`/gateway_accounts/${accountId}/api_keys`)
}

async function getAccount(id: string): Promise<any> {
  const isDirectDebitID = id.match(/^DIRECT_DEBIT:/)
  if (isDirectDebitID) {
    throw new Error(`Direct debit accounts are no longer supported`)
  }
  return Connector.accounts.retrieve(id)
}

async function surcharge(req: Request, res: Response): Promise<void> {
  let service
  const {id} = req.params
  const account = await getAccount(id)

  try {
    service = await AdminUsers.services.retrieveByGatewayAccountId(id)
  } catch (error: any) {
    logger.warn(`Services request for gateway account ${id} returned "${error.message}"`)
  }

  res.render('gateway_accounts/surcharge', {account, service, csrf: req.csrfToken()})
}

async function updateSurcharge(req: Request, res: Response): Promise<void> {
  const {id} = req.params
  const {
    corporate_credit_card_surcharge_amount,
    corporate_debit_card_surcharge_amount,
    corporate_prepaid_debit_card_surcharge_amount
  } = req.body

  await Connector.accounts.update(id, {corporate_credit_card_surcharge_amount: Number(corporate_credit_card_surcharge_amount)})
  await Connector.accounts.update(id, {corporate_debit_card_surcharge_amount: Number(corporate_debit_card_surcharge_amount)})
  await Connector.accounts.update(id, {corporate_prepaid_debit_card_surcharge_amount: Number(corporate_prepaid_debit_card_surcharge_amount)})
  req.flash('info', 'Corporate surcharge values updated')
  res.redirect(`/gateway_accounts/${id}`)
}

async function emailBranding(req: Request, res: Response): Promise<void> {
  const {id} = req.params
  const account = await getAccount(id)

  res.render('gateway_accounts/email_branding', {account, csrf: req.csrfToken()})
}

async function updateEmailBranding(req: Request, res: Response):
  Promise<void> {
  const {id} = req.params
  const schema: Joi.ObjectSchema<NotifySettings> = Joi.object({
    service_id: Joi.string().required().pattern(NOTIFY_ID_PATTERN).label("Notify Service ID").trim(),
    api_token: Joi.string().required().label("Notify API key").trim(),
    template_id: Joi.string().required().pattern(NOTIFY_ID_PATTERN).label("Payment confirmation template ID").trim(),
    refund_issued_template_id: Joi.string().required().pattern(NOTIFY_ID_PATTERN).label("Refund template ID").trim(),
    email_reply_to_id: Joi.string().optional().pattern(NOTIFY_ID_PATTERN).allow('')
      .error(new ValidationError('Reply-to email address ID must be an ID or left blank (not an email address)'))
      .trim()
  }).options({stripUnknown: true})
  const {error, value: notifySettings} = schema.validate(req.body)
  if (error) {
    throw error
  }
  if (!notifySettings.email_reply_to_id) {
    delete notifySettings.email_reply_to_id
  }

  await Connector.accounts.update(id, {notify_settings: notifySettings})
  req.flash('info', 'Email custom branding successfully updated')
  res.redirect(`/gateway_accounts/${id}`)
}

async function blockPrepaidCards(
  req: Request,
  res: Response
): Promise<void> {
  const {id} = req.params
  const account = await Connector.accounts.retrieve(id)

  const allowed = !account.block_prepaid_cards
  res.render('gateway_accounts/block_prepaid_cards', {
    account,
    allowed,
    csrf: req.csrfToken()
  })
}

async function updateBlockPrepaidCards(
  req: Request,
  res: Response
): Promise<void> {
  const {id} = req.params
  const block = req.body.blocked === 'blocked'
  await Connector.accounts.update(id, {block_prepaid_cards: block})

  req.flash('info', `Prepaid cards are ${block ? 'blocked' : 'allowed'}`)
  res.redirect(`/gateway_accounts/${id}`)
}

async function worldpayExemptionEngine(
  req: Request,
  res: Response
): Promise<void> {
  const {id} = req.params
  const account = await Connector.accounts.retrieve(id)

  if (!account.worldpay_3ds_flex) {
    throw new ValidationError('Worldpay 3DS Flex must be configured before you can enable the exemption engine.')
  }

  const enabled = account.worldpay_3ds_flex && account.worldpay_3ds_flex.exemption_engine_enabled
  res.render('gateway_accounts/worldpay_exemption_engine', {
    account,
    enabled,
    csrf: req.csrfToken()
  })
}

async function updateWorldpayExemptionEngine(req: Request, res: Response): Promise<void> {
  const {id} = req.params
  const enable = req.body.enabled === 'enabled'
  await Connector.accounts.update(id, {worldpay_exemption_engine_enabled: enable})
  req.flash('info', `Worldpay Exception Engine ${enable ? 'enabled' : 'disabled'}`)
  res.redirect(`/gateway_accounts/${id}`)
}

async function worldpayCorporateExemptions(
  req: Request,
  res: Response
): Promise<void> {
  const {id} = req.params
  const account = await Connector.accounts.retrieve(id)

  if (!account.worldpay_3ds_flex) {
    throw new ValidationError('Worldpay 3DS Flex must be configured before you can enable the corporate exemptions.')
  }

  const enabled = account.worldpay_3ds_flex && account.worldpay_3ds_flex.corporate_exemptions_enabled
  res.render('gateway_accounts/worldpay_corporate_exemptions', {
    account,
    enabled,
    csrf: req.csrfToken()
  })
}

async function updateWorldpayCorporateExemptions(req: Request, res: Response): Promise<void> {
  const {id} = req.params
  const enable = req.body.enabled === 'enabled'
  await Connector.accounts.update(id, {worldpay_corporate_exemptions_enabled: enable})
  req.flash('info', `Worldpay Corporate Exemptions ${enable ? 'enabled' : 'disabled'}`)
  res.redirect(`/gateway_accounts/${id}`)
}

async function disableReasonPage(
  req: Request,
  res: Response
): Promise<void> {
  const {id} = req.params
  const account = await getAccount(id)

  res.render('gateway_accounts/disabled_reason', {account, csrf: req.csrfToken()})
}

async function disable(
  req: Request,
  res: Response
): Promise<void> {
  const {id} = req.params
  const {reason} = req.body
  await Connector.accounts.update(id, {
    disabled: true
  })
  await Connector.accounts.update(id, {
    disabled_reason: reason
  })

  res.redirect(`/gateway_accounts/${id}`)
}

async function enable(
  req: Request,
  res: Response
): Promise<void> {
  const {id} = req.params
  await Connector.accounts.update(id, {disabled: false})

  req.flash('info', `Gateway account enabled`)
  res.redirect(`/gateway_accounts/${id}`)
}

async function recurringPayments(
  req: Request,
  res: Response
): Promise<void> {
  const {id} = req.params
  const account = await Connector.accounts.retrieve(id)
  res.render('gateway_accounts/recurring_payments', {
    account,
    csrf: req.csrfToken()
  })
}

async function updateRecurringPayments(
  req: Request,
  res: Response
): Promise<void> {
  const {id} = req.params
  const enabled = req.body.enabled === 'enabled'
  await Connector.accounts.update(id, {recurring_enabled: enabled})

  req.flash('info', `Recurring card payments ${enabled ? 'enabled' : 'disabled'}`)
  res.redirect(`/gateway_accounts/${id}`)
}

async function updateStripeStatementDescriptorPage(
  req: Request,
  res: Response
): Promise<void> {
  const {id} = req.params
  const account = await getAccount(id)

  res.render('gateway_accounts/stripe_statement_descriptor', {account, csrf: req.csrfToken()})
}

async function updateStripePayoutDescriptorPage(
  req: Request,
  res: Response
): Promise<void> {
  const {id} = req.params
  const account = await getAccount(id)
  res.render('gateway_accounts/stripe_payout_descriptor', {account, csrf: req.csrfToken()})
}

async function updateStripeStatementDescriptor(
  req: Request,
  res: Response
): Promise<void> {
  const {statement_descriptor} = req.body
  const {id} = req.params
  const [account, stripeCredentials] = await Promise.all([
    getAccount(id),
    Connector.accounts.retrieveStripeCredentials(id)
  ])
  const {stripe_account_id} = stripeCredentials

  if (!statement_descriptor) {
    throw new Error('Cannot update empty state descriptor')
  }

  if (!stripe_account_id) {
    throw new Error('Invalid Stripe account configuration')
  }

  const updateParams = {
    settings: {
      payments: {
        statement_descriptor
      }
    }
  }
  await stripeClient.getStripeApi(account.live).accounts.update(
    stripe_account_id,
    updateParams
  )
  req.flash('info', `Statement descriptor updated to [${statement_descriptor}]`)
  res.redirect(`/gateway_accounts/${id}`)
}

async function updateStripePayoutDescriptor(
  req: Request,
  res: Response
): Promise<void> {
  const {statement_descriptor} = req.body
  const {id} = req.params
  const [account, stripeCredentials] = await Promise.all([
    getAccount(id),
    Connector.accounts.retrieveStripeCredentials(id)
  ])
  const {stripe_account_id} = stripeCredentials

  if (!statement_descriptor) {
    throw new Error('Cannot update empty state descriptor')
  }

  if (!stripe_account_id) {
    throw new Error('Invalid Stripe account configuration')
  }

  const updateParams = {
    settings: {
      payouts: {
        statement_descriptor
      }
    }
  }
  await stripeClient.getStripeApi(account.live).accounts.update(
    stripe_account_id,
    updateParams
  )
  req.flash('info', `Payout descriptor updated to [${statement_descriptor}]`)
  res.redirect(`/gateway_accounts/${id}`)
}

const search = async function search(req: Request, res: Response): Promise<void> {
  res.render('gateway_accounts/search', {csrf: req.csrfToken()})
}

async function searchRequest(req: Request, res: Response, next: NextFunction): Promise<void> {
  const id = req.body.id.trim()
  try {
    await Connector.accounts.retrieve(id)
    return res.redirect(`/gateway_accounts/${id}`)
  } catch (err) {
    if (err instanceof EntityNotFoundError) {
      try {
        const accountByExternalId = await Connector.accounts.retrieveByExternalId(id)
        return res.redirect(`/gateway_accounts/${accountByExternalId.gateway_account_id}`)
      } catch (err) {
        if (err instanceof EntityNotFoundError) {
          const accountByPaymentProviderAccountId = await Connector.accounts.list({payment_provider_account_id: id})
          if (accountByPaymentProviderAccountId['accounts'].length === 1) {
            return res.redirect(`/gateway_accounts/${accountByPaymentProviderAccountId['accounts'][0]['gateway_account_id']}`)
          }
          if (accountByPaymentProviderAccountId['accounts'].length > 1) {
            return res.redirect(`/gateway_accounts?payment_provider_account_id=${id}&live=all`)
          }
        }
      }
    }
    next(err)
  }
}

async function gatewayPaymentData(req: Request, res: Response): Promise<void> {
  const {id} = req.params
  const account = await Connector.accounts.retrieve(id)
  res.render('gateway_accounts/gateway_payment_data', {
    account,
    csrf: req.csrfToken()
  })
}

async function updateGatewayPaymentData(req: Request, res: Response): Promise<void> {
  const {id} = req.params
  if (req.body.description) {
    const sendReferenceInDescription = req.body.description === 'reference'
    await Connector.accounts.update(id, {send_reference_to_gateway: sendReferenceInDescription})
  }

  if (req.body.email) {
    const sendEmail = req.body.email === 'yes'
    await Connector.accounts.update(id, {send_payer_email_to_gateway: sendEmail})
  }

  if (req.body.ip) {
    const sendIp = req.body.ip === 'yes'
    await Connector.accounts.update(id, {send_payer_ip_address_to_gateway: sendIp})
  }

  req.flash('info', 'Payment details sent to gateway updated')
  res.redirect(`/gateway_accounts/${id}`)
}

export default {
  overview: wrapAsyncErrorHandler(overview),
  listCSV: wrapAsyncErrorHandler(listCSV),
  listCSVWithAdminEmails: wrapAsyncErrorHandler(listCSVWithAdminEmails),
  create: wrapAsyncErrorHandler(create),
  confirm: wrapAsyncErrorHandler(confirm),
  writeAccount: wrapAsyncErrorHandler(writeAccount),
  detail: wrapAsyncErrorHandler(detail),
  apiKeys: wrapAsyncErrorHandler(apiKeys),
  revokedApiKeys: wrapAsyncErrorHandler(revokedApiKeys),
  deleteApiKey: wrapAsyncErrorHandler(deleteApiKey),
  surcharge: wrapAsyncErrorHandler(surcharge),
  updateSurcharge: wrapAsyncErrorHandler(updateSurcharge),
  emailBranding: wrapAsyncErrorHandler(emailBranding),
  updateEmailBranding: wrapAsyncErrorHandler(updateEmailBranding),
  blockPrepaidCards: wrapAsyncErrorHandler(blockPrepaidCards),
  updateBlockPrepaidCards: wrapAsyncErrorHandler(updateBlockPrepaidCards),
  disableReasonPage: wrapAsyncErrorHandler(disableReasonPage),
  disable: wrapAsyncErrorHandler(disable),
  enable: wrapAsyncErrorHandler(enable),
  updateStripeStatementDescriptorPage: wrapAsyncErrorHandler(updateStripeStatementDescriptorPage),
  updateStripeStatementDescriptor: wrapAsyncErrorHandler(updateStripeStatementDescriptor),
  updateStripePayoutDescriptorPage: wrapAsyncErrorHandler(updateStripePayoutDescriptorPage),
  updateStripePayoutDescriptor: wrapAsyncErrorHandler(updateStripePayoutDescriptor),
  search: wrapAsyncErrorHandler(search),
  searchRequest: wrapAsyncErrorHandler(searchRequest),
  worldpayExemptionEngine: wrapAsyncErrorHandler(worldpayExemptionEngine),
  updateWorldpayExemptionEngine: wrapAsyncErrorHandler(updateWorldpayExemptionEngine),
  worldpayCorporateExemptions: wrapAsyncErrorHandler(worldpayCorporateExemptions),
  updateWorldpayCorporateExemptions: wrapAsyncErrorHandler(updateWorldpayCorporateExemptions),
  recurringPayments: wrapAsyncErrorHandler(recurringPayments),
  updateRecurringPayments: wrapAsyncErrorHandler(updateRecurringPayments),
  gatewayPaymentData: wrapAsyncErrorHandler(gatewayPaymentData),
  updateGatewayPaymentData: wrapAsyncErrorHandler(updateGatewayPaymentData)
}
