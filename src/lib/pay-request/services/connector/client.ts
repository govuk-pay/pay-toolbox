import _ from 'lodash'
import Client from '../../base'
import { mapRequestParamsToOperation } from '../../utils/request'
import {
    AddGatewayAccountCredentialsRequest,
    AddGitHubAndZendeskCredential,
    Charge,
    CreateGatewayAccountRequest,
    CreateGatewayAccountResponse,
    GatewayAccount,
    GatewayAccountCredentials,
    GatewayStatusComparison,
    ListCardTypesResponse,
    ListGatewayAccountsRequest,
    ListGatewayAccountsResponse,
    StripeCredentials,
    StripeSetup,
    UpdateGatewayAccountRequest,
    UpdateStripeSetupRequest
} from './types'
import { App } from '../../shared'
import { handleEntityNotFound, handleChargeNotFoundForParityCheck } from "../../utils/error";
import { EntityNotFoundError } from '../../../errors'
import { Refund } from "../ledger/types";

/**
 * Convenience methods for accessing resource endpoints for the Connector
 * service.
 */
export default class Connector extends Client {
    constructor() {
        super(App.Connector)
    }

    refunds = ((client: Connector) => ({
        /**
        * Checks if a refund exists in the Connector, returns just 200 or 404 if missing
        * @param id - Refund external ID
        * @returns true if refund exists
         */
        exists(id: string): Promise<boolean> {
            return client._axios
                .get(`/v1/api/refunds/${id}`)
                .then(() => true)
                .catch(handleEntityNotFound(`Refund`, id))
        },

    }))(this)

    charges = ((client: Connector) => ({
        /**
         * Fetch an in-flight payment
         * @param id - Charge external ID
         * @returns In-flight payment object
         */
        retrieve(id: string): Promise<Charge | undefined> {
            return client._axios
                .get(`/v1/frontend/charges/${id}`)
                .then(response => client._unpackResponseData<Charge>(response))
                .catch(handleEntityNotFound("Charge", id))
        },

        /* eslint-disable @typescript-eslint/no-wrapper-object-types */
        parityCheck(externalChargeId: string, accountId: string): Promise<Charge | String> {
            return client._axios
                .get(`/v1/api/accounts/${accountId}/charges/${externalChargeId}`)
                .then(response => client._unpackResponseData<Charge>(response))
                .catch(handleChargeNotFoundForParityCheck())
        },

        /**
         * Get the comparison between the status in Pay and the status with the Gateway for a list of
         * charges
         * @param ids - Charge external IDs
         * @returns Array of gateway comparison objects
         */
        getGatewayComparisons(ids: string[]): Promise<GatewayStatusComparison[] | undefined> {
            return client._axios
                .post('/v1/api/discrepancies/report', ids)
                .then(response => client._unpackResponseData<GatewayStatusComparison[]>(response))
        },

        /**
         * Attempts to cancel an authorisation with the payment gateway
         * @param id - Charge external ID
         * @returns Array of gateway comparison objects
         */
        resolveDiscrepancy(id: string): Promise<GatewayStatusComparison[] | undefined> {
            return client._axios
                .post('/v1/api/discrepancies/resolve', [id])
                .then(response => client._unpackResponseData<GatewayStatusComparison[]>(response))
        }
    }))(this)

    accounts = ((client: Connector) => ({
        /**
         * Get gateway account by gateway account ID
         * @param id - Gateway account ID
         * @returns Gateway account object
         */
        retrieve(id: string): Promise<GatewayAccount | undefined> {
            return client._axios
                .get(`/v1/api/accounts/${id}`)
                .then(response => client._unpackResponseData<GatewayAccount>(response))
                .catch(handleEntityNotFound("Account by ID", id))
        },

        /**
         * Get gateway account by external ID
         * @param externalId - Gateway account external ID
         * @returns Gateway account object
         */
        retrieveByExternalId(externalId: string): Promise<GatewayAccount | undefined> {
            return client._axios
                .get(`/v1/frontend/accounts/external-id/${externalId}`)
                .then(response => client._unpackResponseData<GatewayAccount>(response))
                .catch(handleEntityNotFound("Account by external ID", externalId));
        },

        /**
         * Get gateway account by service external ID and account type
         * @param serviceExternalId - Service external ID
         * @param accountType - Gateway account type
         * @returns Gateway account object
         */
        retrieveByServiceExternalIdAndAccountType(serviceExternalId: string, accountType: string): Promise<GatewayAccount | undefined> {
            return client._axios
                .get(`/v1/api/service/${serviceExternalId}/account/${accountType}`)
                .then(response => client._unpackResponseData<GatewayAccount>(response))
                .catch(handleEntityNotFound("Account by service external ID and account Type", `${serviceExternalId}:${accountType}`));
        },

        /**
         * Fetch Stripe credentials map for a given gateway account. If the gateway
         * account doesn't have Stripe credentials this route will return not found.
         * @param id - Gateway account ID
         * @returns Stripe credentials for a requested gateway account
         */
        retrieveStripeCredentials(id: string): Promise<StripeCredentials | undefined> {
            return client._axios
                .get(`/v1/api/accounts/${id}/stripe-account`)
                .then(response => client._unpackResponseData<StripeCredentials>(response))
        },

        /**
         * Retrieves which Stripe Connect account setup tasks have been completed for the gateway account
         * @param id - Gateway account ID
         * @returns Stripe account setup object
         */
        retrieveStripeSetup(id: string): Promise<StripeSetup | undefined> {
            return client._axios
                .get(`/v1/api/accounts/${id}/stripe-setup`)
                .then(response => client._unpackResponseData<StripeSetup>(response))
        },

        /**
         * List all supported account types currently enabled by the specified gateway
         * account
         * @param id - Gateway account ID
         * @returns List of card types supported by this gateway account
         */
        listCardTypes(id: string): Promise<ListCardTypesResponse | undefined> {
            return client._axios
                .get(`/v1/frontend/accounts/${id}/card-types`)
                .then(response => client._unpackResponseData<ListCardTypesResponse>(response))
        },

        /*
         * List gateway accounts (internal API view)
         * @param filters - optional parameters to filter account list
         * @returns List gateway account response
         */
        list(filters: ListGatewayAccountsRequest = {}): Promise<ListGatewayAccountsResponse | undefined> {
            const params = _.omitBy(filters, _.isEmpty)
            return client._axios
                .get('/v1/api/accounts', { params })
                .then(response => client._unpackResponseData<ListGatewayAccountsResponse>(response))
        },

        /*
         * Get one gateway account given service ID. This is a polyfill method until service ID and live/ test are the primary index for accounts on the backend.
         */
        async retrieveForService(filters: ListGatewayAccountsRequest = {}): Promise<GatewayAccount | undefined> {
            const params = _.omitBy(filters, _.isEmpty)
            const { accounts } = await client._axios
                .get('/v1/api/accounts', { params })
                .then(response => client._unpackResponseData<ListGatewayAccountsResponse>(response))

            if (accounts.length > 1) {
                throw new Error(`Multiple accounts for service ${filters.serviceIds} ${filters.type}, this is a legacy configuration`)
            }

            if (!accounts.length) {
                throw new EntityNotFoundError('Account for service', filters.serviceIds)
            }

            return accounts[0]
        },

        /**
         * Create a new gateway account
         * @param params - Gateway account details
         * @returns The created gateway account object
         */
        create(params: CreateGatewayAccountRequest): Promise<CreateGatewayAccountResponse | undefined> {
            return client._axios
                .post('/v1/api/accounts', params)
                .then(response => client._unpackResponseData<CreateGatewayAccountResponse>(response));
        },

        /**
         * Update an existing gateway account. The patch endpoint for accounts only
         * accepts one operation. The patch endpoint for accounts will respond with
         * an empty success response
         * @param id - Gateway account ID
         * @param params - keys to update on the gateway account
         * @returns The updated gateway account object
         */
        update(
            id: string,
            params: UpdateGatewayAccountRequest
        ): Promise<void | undefined> {
            // Note that connector only supports single update per request, rather than an array of updates
            const payload = mapRequestParamsToOperation(params).pop()

            return client._axios
                .patch(`/v1/api/accounts/${id}`, payload)
                .then(() => {
                    return
                });
            // .then(() => this.retrieve(id))
        },

        updateStripeSetup(id: string, params: UpdateStripeSetupRequest): Promise<void> {
            const payload = mapRequestParamsToOperation(params);
            return client._axios
                .patch(`/v1/api/accounts/${id}/stripe-setup`, payload)
        },

        addGatewayAccountCredentials(id: string, params: AddGatewayAccountCredentialsRequest): Promise<GatewayAccountCredentials> {
            return client._axios
                .post(`/v1/api/accounts/${id}/credentials`, params)
                .then(response => client._unpackResponseData<GatewayAccountCredentials>(response));
        }

    }))(this)

    cardTypes = ((client: Connector) => ({
        /**
         * List all card types supported by the platform
         * @returns List of card types
         */
        list(): Promise<ListCardTypesResponse | undefined> {
            return client._axios
                .get('/v1/api/card-types')
                .then(response => client._unpackResponseData<ListCardTypesResponse>(response));
        }
    }))(this)


    eventEmitter = ((client: Connector) => ({
        emitByIdRange(startId: number, maxId: number, recordType: string, retryDelayInSeconds: number): Promise<void> {
            const params = {
                start_id: startId,
                max_id: maxId,
                record_type: recordType,
                do_not_retry_emit_until: retryDelayInSeconds
            }
            return client._axios
                .post('/v1/tasks/historical-event-emitter', null, { params })
                .then(() => {
                    return
                })
        },

        emitByDate(startDate: string, endDate: string, retryDelayInSeconds: number): Promise<void> {
            const params = {
                start_date: startDate,
                end_date: endDate,
                do_not_retry_emit_until: retryDelayInSeconds
            }
            return client._axios
                .post('/v1/tasks/historical-event-emitter-by-date', null, { params })
                .then(() => {
                    return
                })
        }
    }))(this)

    parityChecker = ((client: Connector) => ({
        runParityCheck(
            startId: number,
            maxId: number,
            doNotReprocessValidRecords: boolean,
            parityCheckStatus: string,
            retryDelayInSeconds: number,
            recordType: string): Promise<void> {
            const params = {
                start_id: startId,
                max_id: maxId,
                do_not_reprocess_valid_records: doNotReprocessValidRecords,
                parity_check_status: parityCheckStatus,
                do_not_retry_emit_until: retryDelayInSeconds,
                record_type: recordType
            }
            return client._axios
                .post('/v1/tasks/parity-checker', null, { params })
                .then(() => {
                    return
                })
        }
    }))(this)


    fixAsyncFailedStripeRefund = ((client: Connector) => ({
        fixStripeRefund(gatewayAccountId: string, chargeId: string, refundId: string, params: AddGitHubAndZendeskCredential): Promise<Refund> {
            return client._axios
                .post(`/v1/api/accounts/${gatewayAccountId}/charges/${chargeId}/refunds/${refundId}/reverse-failed`, params)
                .then(response => client._unpackResponseData<Refund>(response))
                .catch(handleEntityNotFound("refund", refundId));
        }
    }))(this)
}
