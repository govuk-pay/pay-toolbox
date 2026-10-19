import * as exceptions from './services.exceptions'
import {
  branding,
  createWorldpayTestService,
  createWorldpayTestServiceConfirmationPage,
  detail,
  linkAccounts,
  listCsv,
  overview,
  performancePlatformCsv,
  search,
  searchRequest,
  toggleArchiveService,
  toggleExperimentalFeaturesEnabledFlag,
  toggleTerminalStateRedirectFlag,
  updateBranding,
  updateLinkAccounts,
  updateOrganisation,
  updateOrganisationForm,
  goLive,
  createAdyenTestService,
  createAdyenTestServiceConfirmationPage
} from './services.http'
import { getUpdateFeatureForm, postUpdateFeatureForm } from './features/features.http'

export default {
  overview: overview,
  listCsv: listCsv,
  performancePlatformCsv: performancePlatformCsv,
  detail: {
    http: detail,
    exceptions: exceptions.detail
  },
  branding: branding,
  updateBranding: updateBranding,
  linkAccounts: linkAccounts,
  updateLinkAccounts: {
    http: updateLinkAccounts,
    exceptions: exceptions.updateLinkAccounts
  },
  search: search,
  searchRequest: searchRequest,
  toggleTerminalStateRedirectFlag: toggleTerminalStateRedirectFlag,
  toggleExperimentalFeaturesEnabled: toggleExperimentalFeaturesEnabledFlag,
  updateOrganisationForm: updateOrganisationForm,
  updateOrganisation: updateOrganisation,
  toggleArchiveService: toggleArchiveService,
  goLive: goLive,
  createWorldpayTestService: createWorldpayTestService,
  createWorldpayTestServiceConfirmationPage: createWorldpayTestServiceConfirmationPage,
  updateFeature: getUpdateFeatureForm,
  updateFeatureForm: postUpdateFeatureForm,
  createAdyenTestService: createAdyenTestService,
  createAdyenTestServiceConfirmationPage: createAdyenTestServiceConfirmationPage
}
