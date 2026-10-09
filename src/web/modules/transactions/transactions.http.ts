import { NextFunction, Request, Response } from 'express'

import { AdminUsers, Connector, Ledger, Webhooks } from '../../../lib/pay-request/client'
import { EntityNotFoundError } from '../../../lib/errors'
import logger from '../../../lib/logger'
import { AccountType, TransactionType } from '../../../lib/pay-request/shared'
import { PaymentListFilterStatus, resolvePaymentStates, resolveRefundStates } from "./states";
import { ifEntityNotFound } from "../common/ifEntityNotFound";
import { GatewayAccount, WorldpayCredentials } from '../../../lib/pay-request/services/connector/types'
import { Transaction } from '../../../lib/pay-request/services/ledger/types'

const process = require('process')
const url = require('url')
const https = require('https')
const moment = require('moment')
const rfc822Validator = require('rfc822-validate')

const { common, services } = require('./../../../config')
const { constants } = require('@govuk-pay/pay-js-commons')

if (common.development) {
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = 0
}

function isAnEmail(value: string): boolean {
  return rfc822Validator(value)
}

export async function searchPage(req: Request, res: Response): Promise<void> {
  res.render('transactions/search', { csrf: req.csrfToken() })
}

export async function search(req: Request, res: Response, next: NextFunction): Promise<void> {
  const id = req.body.id && req.body.id.trim()

  try {
    if (isAnEmail(id)) {
      const emailSearch = await Ledger.transactions.list({
        override_account_id_restriction: true,
        email: id
      })

      if (emailSearch.results.length > 1) {
        res.redirect(`/transactions?email=${id}`)
        return
      } else if (emailSearch.results.length === 1) {
        res.redirect(`/transactions/${emailSearch.results[0].transaction_id}`)
        return
      }
    } else {
      await Ledger.transactions.retrieve(id)
      res.redirect(`/transactions/${id}`)
    }
  } catch (error) {
    if (error instanceof EntityNotFoundError) {
      const referenceSearch = await Ledger.transactions.list({
        override_account_id_restriction: true,
        reference: id
      })

      if (referenceSearch.results.length > 1) {
        res.redirect(`/transactions?reference=${id}`)
        return
      } else if (referenceSearch.results.length === 1) {
        res.redirect(`/transactions/${referenceSearch.results[0].transaction_id}`)
        return
      }

      const gatewayTransactionIdSearch = await Ledger.transactions.list({
        override_account_id_restriction: true,
        gateway_transaction_id: id
      })
      if (gatewayTransactionIdSearch.results.length > 1) {
        res.redirect(`/transactions?gateway_transaction_id=${id}`)
        return
      } else if (gatewayTransactionIdSearch.results.length === 1) {
        res.redirect(`/transactions/${gatewayTransactionIdSearch.results[0].transaction_id}`)
        return
      }

      next(new EntityNotFoundError('Transaction search with criteria ', id))
      return
    }
    next(error)
  }
}

export async function list(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    let service, account
    const accountId = req.query.account
    const selectedStatus = req.query.status as PaymentListFilterStatus || PaymentListFilterStatus.All
    const transactionType = req.query.type && req.query.type.toString().toUpperCase() as TransactionType || TransactionType.Payment
    const warnings: string[] = []

    const filters = {
      ...req.query.reference && { reference: req.query.reference as string },
      ...req.query.email && { email: req.query.email as string },
      ...req.query.gateway_transaction_id && { gateway_transaction_id: req.query.gateway_transaction_id as string },
      ...req.query.gateway_payout_id && { gateway_payout_id: req.query.gateway_payout_id as string },
      ...req.query.agreement_id && { agreement_id: req.query.agreement_id as string }
    }
    const page = req.query.page && Number(req.query.page) || 1
    const pageSize = 20
    const limitTotalSize = 5000
    const response = await Ledger.transactions.list({
      override_account_id_restriction: !accountId,
      page,
      display_size: pageSize,
      limit_total: true,
      limit_total_size: limitTotalSize,
      ...transactionType && { transaction_type: transactionType as TransactionType },
      ...accountId && { account_id: Number(accountId) },
      ...transactionType === TransactionType.Payment && { payment_states: resolvePaymentStates(selectedStatus) },
      ...transactionType === TransactionType.Refund && { refund_states: resolveRefundStates(selectedStatus) },
      ...filters
    })

    if (req.query.account) {
      account = await Connector.accounts.retrieve(accountId as string)
        .catch(ifEntityNotFound(() => warnings.push('Transactions were found for this gateway account but no gateway account was returned by Connector'), Boolean(response.results.length)))
      service = await AdminUsers.services.retrieveByGatewayAccountId(accountId as string)
        .catch(ifEntityNotFound(() => warnings.push('Transactions were found for this gateway account but no service was found for this account'), Boolean(response.results.length)))
    }

    res.render('transactions/list', {
      transactions: response.results,
      selectedStatus,
      filters,
      set: response,
      account,
      service,
      accountId,
      transactionType,
      warnings
    })
  } catch (error) {
    next(error)
  }
}

function getMerchantCodeForTransaction(account: GatewayAccount, transaction: Transaction): string | undefined {
  let merchantCode
  const credentials = account.gateway_account_credentials
  const transactionCredentials = credentials.find(credential => credential.external_id === transaction.credential_external_id)?.credentials as WorldpayCredentials
  const agreementId = transaction.agreement_id
  const authorisationMode = transaction.authorisation_mode

  if (agreementId && authorisationMode === 'agreement') {
    merchantCode = transactionCredentials?.recurring_merchant_initiated?.merchant_code
  } else if (agreementId) {
    merchantCode = transactionCredentials?.recurring_customer_initiated?.merchant_code
  } else {
    merchantCode = transactionCredentials?.one_off_customer_initiated?.merchant_code
  }
  return merchantCode
}

export async function show(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const warnings: string[] = []
    const transaction = await Ledger.transactions.retrieve(req.params.id)
    const account = await Connector.accounts.retrieve(transaction.gateway_account_id)
      .catch(ifEntityNotFound(() => warnings.push(`Transaction was found but no gateway account exists in Connector with corresponding ID (${transaction.gateway_account_id})`)));
    const service = await AdminUsers.services.retrieveByGatewayAccountId(transaction.gateway_account_id)
      .catch(ifEntityNotFound(() => warnings.push(`Transaction was found but no service was found with corresponding gateway account ID (${transaction.gateway_account_id})`)))
    const relatedTransactions = []
    let stripeDashboardUri = ''

    const checkTransactionExistsInConnector = async (type: TransactionType, id: string): Promise<boolean> => {
      switch (type) {
        case TransactionType.Payment: {
          const charge = await Connector.charges.retrieve(id)
            .catch(ifEntityNotFound((): null => null))
          return Boolean(charge)
        }
        case TransactionType.Refund: {
          const refundResponse = await Connector.refunds.existsById(id)
            .catch(ifEntityNotFound((): null => null))
          return Boolean(refundResponse)
        }
        case TransactionType.Dispute:
        default:
          return false // Disputes are never stored in Connector
      }
    }

    const existsInConnector = await checkTransactionExistsInConnector(transaction.transaction_type, req.params.id)

    const transactionEvents = await Ledger.transactions.listEvents(transaction.transaction_id, {
      gateway_account_id: transaction.gateway_account_id,
      include_all_events: true
    })

    const events = transactionEvents.events
      .map((event: any) => {
        event.data = Object.keys(event.data).length ? event.data : null
        return event
      })

    let userJourneyDurationFriendly: string = 'Not available'
    const paymentStartedEvent = events.find((event: any) => event.event_type === 'PAYMENT_STARTED')
    if (paymentStartedEvent) {
      const endOfUserJourneyEvent = events.find((event: any) => event.event_type === 'USER_APPROVED_FOR_CAPTURE' ||
        event.event_type === 'USER_APPROVED_FOR_CAPTURE_AWAITING_SERVICE_APPROVAL' ||
        event.event_type === 'CANCELLED_BY_USER' ||
        event.event_type === 'AUTHORISATION_REJECTED' ||
        event.event_type === 'GATEWAY_ERROR_DURING_AUTHORISATION');
      if (endOfUserJourneyEvent) {
        const userJourneyDurationMillis: number = Date.parse(endOfUserJourneyEvent.timestamp) - Date.parse(paymentStartedEvent.timestamp)
        const userJourneyDurationSeconds: number = Math.floor(userJourneyDurationMillis / 1000)

        userJourneyDurationFriendly = ''

        const hours: number = Math.floor(userJourneyDurationSeconds / 3600)
        if (hours) {
          userJourneyDurationFriendly += hours + ' hour' + (hours !== 1 ? 's, ' : ', ')
        }

        const minutes: number = Math.floor(userJourneyDurationSeconds / 60) % 60
        if (hours || minutes) {
          userJourneyDurationFriendly += minutes + ' minute' + (minutes !== 1 ? 's and ' : ' and ')
        }

        const seconds: number = userJourneyDurationSeconds % 60
        if (hours || minutes || seconds) {
          userJourneyDurationFriendly += seconds + ' second' + (seconds !== 1 ? 's' : '')
        }
      }
    }

    const relatedResult = await Ledger.transactions.retrieveRelatedTransactions(transaction.transaction_id,
      { gateway_account_id: transaction.gateway_account_id })
    relatedTransactions.push(...relatedResult.transactions)

    let parentTransaction
    if (transaction.parent_transaction_id) {
      parentTransaction = await Ledger.transactions.retrieve(transaction.parent_transaction_id)
    }

    const webhookMessages = []
    try {
      const webhooks = await Webhooks.webhooks.list({
        service_id: service?.external_id,
        gateway_account_id: `${account?.gateway_account_id}`,
        live: account?.type === AccountType.Live
      })

      for (const webhook of webhooks) {
        const messages = await Webhooks.webhooks.listMessages(webhook.external_id, {
          resource_id: transaction.transaction_id
        })
        webhookMessages.push(...messages.results.map((webhookMessage) => ({ ...webhookMessage, webhook_id: webhook.external_id })))
      }
    } catch (webhooksError) {
      logger.warn('Failed to fetch webhooks data for the payments page', webhooksError)
    }

    if (transaction.gateway_transaction_id && account?.payment_provider === 'stripe') {
      stripeDashboardUri = `https://dashboard.stripe.com/${transaction.live ? '' : 'test/'}payments/${transaction.gateway_transaction_id}`
    }

    const renderKey = transaction.transaction_type

    let merchantCode

    if (account.payment_provider === 'worldpay') {
      merchantCode = getMerchantCodeForTransaction(account, transaction)
    }

    const context = {
      transaction,
      service,
      events,
      webhookMessages,
      warnings,
    }

    switch (renderKey) {
      case TransactionType.Payment: {
        return res.render(`transactions/payment`, {
          ...context,
          relatedTransactions,
          stripeDashboardUri,
          humanReadableSubscriptions: constants.webhooks.humanReadableSubscriptions,
          userJourneyDurationFriendly,
          isExpunged: !existsInConnector,
          merchantCode
        })
      }
      case TransactionType.Refund: {
        return res.render(`transactions/refund`, {
          ...context,
          parentTransaction,
          isExpunged: !existsInConnector
        })
      }
      case TransactionType.Dispute: {
        return res.render(`transactions/dispute`, {
          ...context,
          parentTransaction,
        })
      }
      default:
        return next(new Error(`Unknown transaction type [${transaction.transaction_type}]`))
    }
  } catch (error) {
    next(error)
  }
}

const sum = (a: number, b: number): number => a + b

export async function statistics(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    let service
    const accountId = req.query.account as string

    if (req.query.account) {
      service = await AdminUsers.services.retrieveByGatewayAccountId(accountId)
    } else {
      throw new Error('Platform statistics not supported by Ledger')
    }

    const periodKeyMap: { [key: string]: string } = {
      today: 'day',
      week: 'week',
      month: 'month'
    }
    const selectedPeriod: any = req.query.period || 'today'
    const momentKey = periodKeyMap[selectedPeriod]

    const fromDate: string = moment().utc().startOf(momentKey).format()
    const toDate: string = moment().utc().endOf(momentKey).format()

    const account = await Connector.accounts.retrieve(accountId);
    const includeMotoStatistics = account.allow_moto;

    const paymentsByState = await Ledger.reports.retrievePaymentSummaryByState({
      account_id: accountId,
      from_date: fromDate,
      to_date: toDate
    })
    const paymentStatistics = await Ledger.reports.retrieveTransactionSummary({
      account_id: accountId,
      override_from_date_validation: true,
      include_moto_statistics: includeMotoStatistics,
      ...fromDate && { from_date: fromDate },
      ...toDate && { to_date: toDate },
    })

    const results = {
      includeMotoStatistics,
      payments: paymentStatistics.payments.count,
      gross: paymentStatistics.payments.gross_amount,
      motoPayments: paymentStatistics.moto_payments.count,
      refunds: paymentStatistics.refunds.count,
      netIncome: paymentStatistics.net_income,
      success: paymentsByState.success,
      error: paymentsByState.error,
      in_progress: [
        paymentsByState.created,
        paymentsByState.started,
        paymentsByState.submitted,
        paymentsByState.capturable
      ].reduce(sum, 0)
    }

    res.render('transactions/statistics', {
      service,
      accountId,
      selectedPeriod,
      results
    })
  } catch (error) {
    next(error)
  }
}

export async function csvPage(req: Request, res: Response, next: NextFunction): Promise<void> {
  const now = moment()
  const years = []
  const totalNumberOfYears = 5

  let service
  const accountId = req.query.account as string

  try {
    if (req.query.account) {
      service = await AdminUsers.services.retrieveByGatewayAccountId(accountId)
    }

    for (let i = 0; i < totalNumberOfYears; i++) years.push(now.year() - i)

    res.render('transactions/csv', {
      accountId,
      service,
      years,
      months: moment.months(),
      csrf: req.csrfToken()
    })
  } catch (error) {
    next(error)
  }
}

export async function streamCsv(req: Request, res: Response, next: NextFunction): Promise<void> {
  const {
    accountId,
    month,
    year,
    includeYear
  } = req.body
  const baseDate = moment()
  const periodCode = includeYear ? 'year' : 'month'

  baseDate.set('year', year)
  baseDate.set('month', month)

  const filters = {
    from_date: baseDate.startOf(periodCode).toISOString(),
    to_date: baseDate.endOf(periodCode).toISOString(),
    display_size: 100000
  }

  const headers = {
    Accept: 'text/csv',
    'Content-Type': 'text/csv'
  }

  let serviceDetails
  let gatewayAccountDetails
  try {
    if (accountId) {
      serviceDetails = await AdminUsers.services.retrieveByGatewayAccountId(accountId)
      gatewayAccountDetails = await Connector.accounts.retrieve(accountId)
    }

    const feeHeaders = gatewayAccountDetails && gatewayAccountDetails.payment_provider === 'stripe'

    const params: any = {
      override_account_id_restriction: true,
      payment_states: '',
      exact_reference_match: true,
      ...filters,
      ...accountId && { account_id: accountId },
      ...feeHeaders && { fee_headers: feeHeaders }
    }

    const accountName = serviceDetails ? serviceDetails.name : 'GOV.UK Platform'
    res.set('Content-Type', 'text/csv')
    res.set('Content-Disposition', `attachment; filename="${accountName} ${includeYear ? '' : moment.months()[month]} ${year}.csv"`)

    const query = Object.keys(params)
      .map((key: string) => `${key}=${params[key]}`)
      .join('&')

    // immediately inform browser of file -- expect ~10s of Ledger database query for 50,000 rows
    res.write('')

    const metricStart = Date.now()
    const target = `${services.LEDGER_URL}/v1/transaction?${query}`
    const parsed = url.parse(target)
    const options = {
      path: `${parsed.pathname}${parsed.search}`,
      host: parsed.hostname,
      port: parsed.port,
      method: 'GET',
      headers
    }

    const request = https.request(options, (response: any) => {
      let count = 0

      response.on('data', (chunk: ArrayBuffer) => {
        count += 1
        res.write(chunk)
      })

      response.on('end', () => {
        const metricEnd = Date.now()
        logger.info('Completed file stream', {
          accountId,
          number_of_chunks: count,
          time_taken: metricEnd - metricStart
        })
        res.end()
      })
    })

    request.on('error', (error: Error) => {
      throw new Error(`Streaming transaction CSV attachment failed ${error.message}`)
    })

    request.end()
  } catch (error) {
    next(error)
  }
}
