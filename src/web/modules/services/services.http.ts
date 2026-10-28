import {NextFunction, Request, Response} from 'express'
import {ParsedQs, stringify} from 'qs'

import logger from '../../../lib/logger'
import {AdminUsers, Connector, PublicAuth} from '../../../lib/pay-request/client'
import type {Service} from '../../../lib/pay-request/services/admin_users/types'
import {GoLiveStage} from "../../../lib/pay-request/services/admin_users/types";
import {sanitiseCustomBrandingURL} from './branding'
import GatewayAccountRequest from './gatewayAccountRequest.model'
import {formatPerformancePlatformCsv} from './performancePlatformCsv'
import {ClientFormError, formatErrorsForTemplate} from '../common/validationErrorFormat'
import UpdateOrganisationFormRequest from './UpdateOrganisationForm'
import {EntityNotFoundError, IOValidationError, ValidationError as CustomValidationError} from '../../../lib/errors'
import {formatServiceExportCsv} from './serviceExportCsv'
import {BooleanFilterOption} from '../common/BooleanFilterOption'
import {fetchAndFilterServices, getLiveNotArchivedServices, ServiceFilters} from './getFilteredServices'
import {providers} from "../../../lib/providers";
import {
    CreateGatewayAccountRequest,
    CreateGatewayAccountResponse, GatewayAccount
} from "../../../lib/pay-request/services/connector/types";
import {AccountType} from "../../../lib/pay-request/shared";
import {TokenState} from "../../../lib/pay-request/services/public_auth/types";

function extractFiltersFromQuery(query: ParsedQs): ServiceFilters {
  return {
    live: query.live as BooleanFilterOption || BooleanFilterOption.True,
    internal: query.internal as BooleanFilterOption || BooleanFilterOption.False,
    archived: query.archived as BooleanFilterOption || BooleanFilterOption.False
  }
}

export async function overview(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const filters = extractFiltersFromQuery(req.query)
    const services = await fetchAndFilterServices(filters)
    res.render('services/overview', {
      services,
      filters,
      total: services.length.toLocaleString(),
      csvUrl: `/services/csv?${stringify(filters)}`
    })
  } catch(error) {
    next(error)
  }
}

export async function listCsv(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const filters = extractFiltersFromQuery(req.query)
    const services = await fetchAndFilterServices(filters)

    res.set('Content-Type', 'text/csv')
    res.set('Content-Disposition', `attachment; filename="GOVUK_PAY_services_${stringify(filters)}.csv"`)
    res.status(200).send(formatServiceExportCsv(services))
  } catch (error) {
    next(error)
  }
}

export async function performancePlatformCsv(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const liveActiveServices = await getLiveNotArchivedServices()

    res.set('Content-Type', 'text/csv')
    res.set('Content-Disposition', `attachment; filename="GOVUK_Pay_live_services_for_performance_platform.csv"`)
    res.status(200).send(formatPerformancePlatformCsv(liveActiveServices))
  } catch (error) {
    next(error)
  }
}

const getServiceGatewayAccounts = async (gateway_account_ids: Array<string>) => {
  const serviceGatewayAccounts = []
  for (const id of gateway_account_ids) {
    serviceGatewayAccounts.push(await Connector.accounts.retrieve(id))
  }
  return serviceGatewayAccounts
}

function isATestServiceForPaymentProvider(serviceGatewayAccounts: GatewayAccount[], paymentProvider: string) {
  return serviceGatewayAccounts.length === 1 && serviceGatewayAccounts[0].type === 'test' &&
    serviceGatewayAccounts[0].payment_provider.toUpperCase() === paymentProvider.toUpperCase()
}

export async function detail(req: Request, res: Response, next: NextFunction): Promise<void> {

  try {
    const serviceId = req.params.id
    const messages = req.flash('info')

    const [service, users] = await Promise.all([
      AdminUsers.services.retrieve(serviceId),
      AdminUsers.services.listUsers(serviceId)
    ])

    const userDetails = users.map(user => {
      const currentServicesRole = user.service_roles
          .find((serviceRole) => serviceRole.service && serviceRole.service.external_id === serviceId)
      return {
        external_id: user.external_id,
        role: currentServicesRole.role.name,
        email: user.email,
        disabled: user.disabled
      }
    })

    const [serviceGatewayAccounts, testGatewayAccount] = await Promise.all([
        getServiceGatewayAccounts(service.gateway_account_ids),
        Connector.accounts.retrieveByServiceExternalIdAndAccountType(serviceId, 'test')
            .catch<any>(e => {
              if (e instanceof EntityNotFoundError) {
                // don't 404 if no test account is found, show a misconfigured service error instead
                return null
              } else {
                throw e
              }
            })
    ])

    const misconfiguredServiceErrors = []
    if (!testGatewayAccount) {
      misconfiguredServiceErrors.push('No test Gateway Account was returned by Connector')
    } else if (!serviceGatewayAccounts.some(account => account.gateway_account_id === testGatewayAccount.gateway_account_id)) {
      misconfiguredServiceErrors.push(`The test Gateway Account (${testGatewayAccount.gateway_account_id}) returned by Connector is not associated with this service in Adminusers. If this is not an internal Pay service, this needs to be fixed`)
    }

    const adminEmails = userDetails
        .filter((userDetail) => userDetail.role.toLowerCase() == 'admin')
        .map((userDetail) => userDetail.email)
        .toString()

    res.render('services/detail', {
      service,
      serviceGatewayAccounts,
      testGatewayAccount,
      users: userDetails,
      serviceId,
      messages,
      misconfiguredServiceErrors,
      adminEmails,
      showWorldpayTestServiceCreatedSuccess: req.flash('worldpayTestService')[0] === 'success',
      showAdyenTestServiceCreatedSuccess: req.flash('adyenTestService')[0] === 'success',
      isWorldpayTestService: isATestServiceForPaymentProvider(serviceGatewayAccounts, 'worldpay'),
      isAdyenTestService: isATestServiceForPaymentProvider(serviceGatewayAccounts, 'adyen'),
      hasStripeTestAccount: serviceGatewayAccounts.some(item => item.payment_provider === 'stripe')
    })
  } catch (error) {
    next(error)
  }
}

export async function branding(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const serviceId: string = req.params.id
    const service = await AdminUsers.services.retrieve(serviceId)

    res.render('services/branding', {serviceId, service, csrf: req.csrfToken()})
  } catch (error) {
    next(error)
  }
}

export async function updateBranding(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const {id} = req.params

    await AdminUsers.services.update(id, {
          custom_branding: {
            image_url: sanitiseCustomBrandingURL(req.body.image_url),
            css_url: sanitiseCustomBrandingURL(req.body.css_url)
          }
        }
    )

    logger.info(`Updated service branding for ${id}`)
    req.flash('info', `Service ${id} branding successfully replaced`)
    res.redirect(`/services/${id}`)
  } catch (error) {
    next(error)
  }
}

export async function linkAccounts(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const serviceId = req.params.id
    const context: {
      serviceId: string;
      messages: object;
      recovered?: object;
      csrf: string;
    } = {
      serviceId,
      messages: req.flash('error'),
      csrf: req.csrfToken()
    }

    if (req.session.recovered) {
      context.recovered = {...req.session.recovered}
      delete req.session.recovered
    }
    res.render('services/link_accounts', context)
  } catch (error) {
    next(error)
  }
}

export async function updateLinkAccounts(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const serviceId = req.params.id

    const gatewayAccountRequest = new GatewayAccountRequest(req.body)
    await AdminUsers.services.update(serviceId, {
      gateway_account_ids: [gatewayAccountRequest.id.toString()]
    })

    logger.info(`Service ${serviceId} added gateway account ${gatewayAccountRequest.id}`)
    req.flash('info', `Gateway Account ${gatewayAccountRequest.id} linked`)
    res.redirect(`/services/${serviceId}`)
  }  catch (error) {
    next(error)
  }
}

export async function search(req: Request, res: Response): Promise<void> {
  res.render('services/search', {csrf: req.csrfToken()})
}

export async function searchRequest(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const isAdminusersUuid = /^[0-9a-f]{8}[0-9a-f]{4}[1-5][0-9a-f]{3}[89ab][0-9a-f]{3}[0-9a-f]{12}$/
    const filtered = !!req.body.options
    const term = req.body.term.trim()
    if (term !== '') {
      if (isAdminusersUuid.test(term)) {
        res.redirect(`/services/${term}`)
      } else {
        const data = await AdminUsers.services.search({
          service_name: term,
          service_merchant_name: term
        })
        const nameResults = data.name_results.map((serv: Service) => Object.assign(serv, {matched: 'name'}))
        let merchantResults = data.merchant_results.map((serv: Service) => Object.assign(serv, {matched: 'merchant'}))

        // remove results from merchantResults if we have already found the service in nameResults
        const servIds = new Set(nameResults.map((serv: Service) => serv.id))
        merchantResults = merchantResults.filter((serv: Service) => !servIds.has(serv.id))
        const results = filtered
            ? [...nameResults.filter((serv: Service) => serv.current_go_live_stage === 'LIVE'), ...merchantResults.filter((serv: Service) => serv.current_go_live_stage === 'LIVE')]
            : [...nameResults, ...merchantResults]

        res.render('services/search_results', {
          term,
          filtered,
          results,
          total: results.length.toLocaleString(),
          csrf: req.csrfToken()
        })
      }
    } else {
      res.render('services/search', {csrf: req.csrfToken(), error: 'Please enter a search term'})
    }
  } catch (error) {
    next(error)
  }
}

export async function toggleTerminalStateRedirectFlag(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const serviceId = req.params.id

    const service = await AdminUsers.services.retrieve(serviceId);
    const enable = !service.redirect_to_service_immediately_on_terminal_state;
    await AdminUsers.services.update(serviceId, {
      redirect_to_service_immediately_on_terminal_state: enable
    })
    logger.info(`Toggled redirect to service on terminal state flag to ${enable} for service ${serviceId}`, {externalId: serviceId})

    req.flash('info', `Redirect to service on terminal state ${enable ? 'enabled' : 'disabled'}`)
    res.redirect(`/services/${serviceId}`)
  } catch (error) {
    next(error)
  }
}

export async function toggleExperimentalFeaturesEnabledFlag(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const serviceId = req.params.id

    const service = await AdminUsers.services.retrieve(serviceId);
    const enable = !service.experimental_features_enabled
    await AdminUsers.services.update(serviceId, {
      experimental_features_enabled: enable
    })
    logger.info(`Toggled experimental features enabled flag to ${enable} for service ${serviceId}`, {externalId: serviceId})

    req.flash('info', `Experimental features ${enable ? 'enabled' : 'disabled'}`)
    res.redirect(`/services/${serviceId}`)
  } catch (error) {
    next(error)
  }
}

interface RecoverContext {
  service: Service;
  csrf: string;
  formValues?: object;
  errors?: object;
  errorMap?: object[];
}

export async function updateOrganisationForm(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const service = await AdminUsers.services.retrieve(req.params.id)
    const context: RecoverContext = {service, csrf: req.csrfToken()}
    const messages = req.flash('info')
    const {recovered} = req.session

    if (recovered) {
      context.formValues = recovered.formValues

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

    res.render('services/services.update_organisation.njk', {
      ...context,
      messages
    })
  } catch (error) {
    next(error)
  }
}

export async function updateOrganisation(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  const {id} = req.params

  try {
    const updateRequest = new UpdateOrganisationFormRequest(req.body)
    await AdminUsers.services.update(id, {
      'merchant_details/name': updateRequest.name
    })
    req.flash('info', 'Updated organisation')
    res.redirect(`/services/${id}`)
  } catch (error) {
    if (error instanceof IOValidationError) {
      req.session.recovered = {
        formValues: req.body,
        errors: formatErrorsForTemplate(error.source)
      }
      res.redirect(`/services/${id}/organisation`)
      return
    }
    next(error)
  }
}

export async function toggleArchiveService(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const serviceId = req.params.id

    const service = await AdminUsers.services.retrieve(serviceId);
    const archive = !service.archived

    if (archive) {
      const serviceGatewayAccounts = await getServiceGatewayAccounts(service.gateway_account_ids)

      serviceGatewayAccounts.map(async account => {
        const tokensResponse = await PublicAuth.tokens.list({ gateway_account_id: `${account.gateway_account_id}`, token_state: TokenState.Active })

        tokensResponse.tokens.map(async token => {
          await PublicAuth.tokens.delete({gateway_account_id: `${account.gateway_account_id}`, token_link: token.token_link})
          logger.info(`Deleted API Token with token_link ${token.token_link} for Gateway Account ${account.gateway_account_id}`)
        })
      })
    }

    await AdminUsers.services.update(serviceId, {
      archived: archive
    })
    logger.info(`Toggled archive status to ${archive} for service ${serviceId}`, {externalId: serviceId})

    req.flash('info', `Service ${archive ? 'archived' : 'un-archived'}`)
    res.redirect(`/services/${serviceId}`)
  } catch (error) {
    next(error)
  }
}

export async function goLive(
    req: Request,
    res: Response,
    next: NextFunction
) : Promise<void> {
  try {
    const serviceId = req.params.id
    const service = await AdminUsers.services.retrieve(serviceId)
    const provider = getProviderForGoLive(service)
    res.render('services/go_live', {
      serviceId,
      provider,
      serviceName: service.name,
      organisation: service.merchant_details.name
    })
  } catch (error) {
    next(error)
  }
}

function getProviderForGoLive(service: Service) {
  switch (service.current_go_live_stage) {
    case GoLiveStage.TermsAgreedStripe:
      return providers.stripe
    case GoLiveStage.TermsAgreedWorldpay:
      return providers.worldpay
    default:
      throw new CustomValidationError('The service has not completed a request to go live. Current go-live stage: ' + service.current_go_live_stage)
  }
}

export async function createWorldpayTestServiceConfirmationPage(
    req: Request,
    res: Response
) : Promise<void> {
  const serviceId = req.params.id
  res.render('services/create_worldpay_test_service', { serviceId, csrf: req.csrfToken() })
}

export async function createAdyenTestServiceConfirmationPage(
    req: Request,
    res: Response
): Promise<void> {
    const serviceId = req.params.id
    res.render('services/create_adyen_test_service', {serviceId, csrf: req.csrfToken()})
}

export async function createAdyenTestService(
    req: Request,
    res: Response,
    next: NextFunction
): Promise<void> {
    try {
        const newService: Service = await createTestService(req.params.id, 'adyen')

        req.flash('adyenTestService', 'success')
        res.redirect(`/services/${newService.external_id}`)
    } catch (error) {
        next(error)
    }
}

export async function createWorldpayTestService(
    req: Request,
    res: Response,
    next: NextFunction
): Promise<void> {
    try {
        const newService: Service = await createTestService(req.params.id, 'worldpay')

        req.flash('worldpayTestService', 'success')
        res.redirect(`/services/${newService.external_id}`)
    } catch (error) {
        next(error)
    }
}

async function createTestService(serviceId: string, newPaymentProvider: string): Promise<Service> {
    const service = await AdminUsers.services.retrieve(serviceId)

    const newServiceForTestGatewayAccount = await AdminUsers.services.create({
        service_name: service.service_name
    })
    logger.info(`New ${newPaymentProvider} test service ${newServiceForTestGatewayAccount.external_id} created.`)

    const createGatewayAccountResponse = await createTestGatewayAccount(serviceId,
        service, newServiceForTestGatewayAccount, newPaymentProvider)

    const adminUsers = await AdminUsers.services.listUsers(serviceId, 'admin')
    for (const user of adminUsers) {
        await AdminUsers.users.assignServiceAndRoleToUser(user.external_id, newServiceForTestGatewayAccount.external_id, 'admin')
        logger.info(`Admin user ${user.external_id} assigned admin role to service ${newServiceForTestGatewayAccount.external_id}`)
    }

    const updateResponse = await AdminUsers.services.update(newServiceForTestGatewayAccount.external_id,
        {gateway_account_ids: [createGatewayAccountResponse.gateway_account_id]})

    logger.info(`Test service ${updateResponse.service_name} with id ${updateResponse.external_id} 
      linked with gateway account ids ${updateResponse.gateway_account_ids}.`)

    return newServiceForTestGatewayAccount
}

async function createTestGatewayAccount(serviceId: string, service: Service,
                                        newServiceForTestGatewayAccount: Service,
                                        paymentProvider: string): Promise<CreateGatewayAccountResponse> {
    let humanReadablePaymentProvider = paymentProvider.toUpperCase()
    if (paymentProvider === 'adyen') {
      humanReadablePaymentProvider = 'Adyen'
    } else if (paymentProvider === 'worldpay') {
      humanReadablePaymentProvider = 'Worldpay'
    }

    const newServiceName = `${humanReadablePaymentProvider} test service - ${service.service_name.en}`
    const truncatedNewServiceName = newServiceName.substring(0, 50)

    const payload: CreateGatewayAccountRequest = {
        payment_provider: paymentProvider,
        description: `${humanReadablePaymentProvider} Test account spun off from service ${serviceId}`,
        type: AccountType.Test,
        service_name: truncatedNewServiceName,
        service_id: newServiceForTestGatewayAccount.external_id,
        send_payer_email_to_gateway: true,
        send_payer_ip_address_to_gateway: true
    }

    let createGatewayAccountResponse: CreateGatewayAccountResponse

    if (paymentProvider === 'adyen') {
        createGatewayAccountResponse = await Connector.accounts.createAdyenTestAccount(newServiceForTestGatewayAccount.external_id, payload)
    } else {
        createGatewayAccountResponse = await Connector.accounts.create(payload)
    }

    logger.info(`${paymentProvider.toUpperCase()} test gateway account ${createGatewayAccountResponse.gateway_account_id} created.`)
    return createGatewayAccountResponse
}

