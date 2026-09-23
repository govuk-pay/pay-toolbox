const path = require('path')
const fs = require('fs')
const express = require('express')
const metrics = require('@govuk-pay/pay-js-metrics')
const helmet = require('helmet')
const flash = require('connect-flash')
const sessions = require('client-sessions')
const nunjucks = require('nunjucks')
const csurf = require('csurf')
const Sentry = require('@sentry/node')

const {
  common,
  server,
  sentry: sentryConfig,
  disableAuth
} = require('./../config')
const logger = require('./../lib/logger')
const requestLoggingMiddleware = require('../lib/requestLoggingMiddleware')
const passport = require('../lib/auth/passport')
const { configureClients } = require('../lib/pay-request/config')

const errors = require('./errorHandler')
const router = require('./router')

// @FIXME(sfount) move this out of server configuration
const {
  toSimpleDate,
  toFormattedDate,
  toFormattedDateLocalTimeZone,
  toFormattedDateLong,
  toCurrencyString,
  toUnixDate,
  toFormattedDateSince
} = require('./../lib/format')

const app = express()

function configureSecureHeaders(instance) {
  const serverBehindProxy = server.HTTP_PROXY

  // only set certain proxy configured headers if not behind a proxy, the proxy
  // will be responsible for setting these headers
  const helmetOptions = serverBehindProxy ? {
    noSniff: false,
    frameguard: false,
    hsts: false,
    xssFilter: false
  } : {}
  const initGOVUKFrontendSnippet = '\'sha256-tqCUU2yHjDH9fiULK1QKKUFdNg//3tfcIB2bl/5yKI4=\''
  instance.use(helmet(helmetOptions))
  instance.use(helmet({
    contentSecurityPolicy: {
      directives: {
        "default-src": ["'self'"],
        "script-src": [
          "'self'",
          "'unsafe-eval'",
          initGOVUKFrontendSnippet
        ],
        "img-src": ["'self'", 'https://*.githubusercontent.com', 'data:'],
        "style-src": ["'self'", "'unsafe-inline'"],
        "form-action": ["'self'", "https://github.com"]
      }
    },
    crossOriginResourcePolicy: { policy: "cross-origin" }
  }))
  instance.use(csurf())
  instance.use((req, res, next) => {
    res.locals.csrf = req.csrfToken()
    next()
  })
}

function configureRequestParsing(instance) {
  if (!common.development) {
    // service is behind a front-facing proxy - set req IP values accordingly
    instance.enable('trust proxy')
  }

  instance.use(express.urlencoded({ extended: false }))
  instance.use(express.json({ strict: true, limit: '15kb' }))
  instance.use(flash())
}

function configureServingPublicStaticFiles(instance) {
  const cache = { maxage: '1y' }
  instance.use('/public', express.static(path.join(__dirname, '../public'), cache))
  instance.use('/assets/fonts', express.static(path.join(process.cwd(), 'node_modules/govuk-frontend/dist/govuk/assets/fonts'), cache))
  instance.use('/images/favicon.ico', express.static(path.join(process.cwd(), 'node_modules/govuk-frontend/dist/govuk/assets/images/', 'favicon.ico'), cache))
  instance.use('/javascripts/govuk-frontend.js', express.static(path.join(process.cwd(), 'node_modules/govuk-frontend/dist/govuk/all.bundle.js'), cache))
  instance.use('/assets/logos', express.static(path.join(__dirname, '../assets/logos'), cache))
}

function configureClientSessions(instance) {
  const serverBehindProxy = server.HTTP_PROXY
  const thirtyMinutesInMillis = 30 * 60 * 1000
  instance.use(sessions({
    cookieName: 'session',
    secret: server.COOKIE_SESSION_ENCRYPTION_SECRET,
    duration: server.SESSION_COOKIE_DURATION_IN_MILLIS || thirtyMinutesInMillis,
    activeDuration: 5 * 60 * 1000,
    cookie: {
      secureProxy: serverBehindProxy
    }
  }))
}

// Shim for passport version 0.6+ necessary to navigate the use of req.session.regenerate issue
function configureServerSessions(instance) {
  instance.use((req, res, next) => {
    if (!req.session) {
      return next();
    }

    if (req.session.regenerate == null) {
      req.session.regenerate = function (callback) {
        Object.keys(req.session).forEach(function (key) {
          if (
            key !== 'reset' &&
            key !== 'setDuration' &&
            key !== 'last_url' &&
            typeof req.session[key] !== 'function'
          ) {
            delete req.session[key];
          }
        });

        if (callback) callback();
      };
    }

    if (req.session.save == null) {
      req.session.save = function (callback) {
        if (callback) callback();
      };
    }

    next();
  })
}

function configureAuth(instance) {
  const exposeAuthenticatedUserToTemplate = (req, res, next) => {
    res.locals.user = req.user
    res.locals.disableAuth = disableAuth
    next()
  }

  instance.use(passport.initialize())
  instance.use(passport.session())
  instance.use(exposeAuthenticatedUserToTemplate)
}

async function configureTemplateRendering(instance) {
  const staticResourceManifest = await readManifest('manifest')
  const browserManifest = await readManifest('browser.manifest')

  const templateRendererConfig = { autoescape: true, express: instance }

  // include both templates from this repository and from govuk frontend
  const templatePathRoots = [path.join(process.cwd(), 'node_modules/govuk-frontend/dist'), path.join(__dirname, 'modules')]
  const templaterEnvironment = nunjucks.configure(templatePathRoots, templateRendererConfig)

  // make static manifest details available to all templates
  templaterEnvironment.addGlobal('manifest', { ...staticResourceManifest, ...browserManifest })
  templaterEnvironment.addFilter('formatDate', (date) => toFormattedDate(new Date(date)))
  templaterEnvironment.addFilter('formatToSimpleDate', (date) => toSimpleDate(date))
  templaterEnvironment.addFilter('formatDateLocalTimeZone', (date) => toFormattedDateLocalTimeZone(new Date(date)))
  templaterEnvironment.addFilter('formatDateLong', (date) => toFormattedDateLong(new Date(date)))
  templaterEnvironment.addFilter('formatDateSince', (date) => toFormattedDateSince(new Date(date)))
  templaterEnvironment.addFilter('unixDate', (timestamp) => toUnixDate(timestamp))
  templaterEnvironment.addFilter('currency', (currencyInPence) => toCurrencyString(currencyInPence / 100))
  templaterEnvironment.addFilter('isObject', (value) => typeof value === 'object')

  instance.set('view engine', 'njk')
}

function configureRouting(instance) {
  // logger middleware included after flash and body parsing middleware as they
  // alter the call stack (it should ideally be placed just before routes)
  instance.use(logger.middleware)
  instance.use(requestLoggingMiddleware())

  instance.use('/', router)
  instance.use(errors.handleNotFound)
}

// top level service stack wide error handling
function configureErrorHandling(instance) {
  instance.use(errors.handleRequestErrors)
  instance.use(errors.handleDefault)
}

const configureSentry = function configureSentry() {
  Sentry.init({
    dsn: sentryConfig.SENTRY_DSN,
    environment: common.ENVIRONMENT,
    version: `${process.env.npm_package_name}@${process.env.npm_package_version}`,
    beforeSend(event) {
      if (event.request) {
        delete event.request.cookies
        if (event.request.headers) {
          delete event.request.headers.cookie
        }
      }
      return event
    }
  })
}

function configureMetrics (instance) {
  instance.use(metrics.initialise())
}

function configureSentryRequestHandler(instance) {
  instance.use(Sentry.Handlers.requestHandler())
}

function readManifest(name) {
  return new Promise((resolve) => {
    const file = `${name}.json`
    fs.readFile(path.join(__dirname, '..//public', file), (err, data) => {
      if (err) {
        resolve({})
        return
      }
      try {
        const parsed = JSON.parse(data)
        resolve(parsed)
       /* eslint-disable @typescript-eslint/no-unused-vars */
      } catch (error) {
        logger.warn('Failed to parse manifest', { path })
        resolve({})
      }
    })
  })
}

// order of configuration options important given the nature of Express Middleware
const configure = [
  configureMetrics,
  configureSentry,
  configureSentryRequestHandler,
  configureRequestParsing,
  configureClientSessions,
  configureServerSessions,
  configureAuth,
  configureSecureHeaders,
  configureServingPublicStaticFiles,
  configureTemplateRendering,
  configureRouting,
  configureErrorHandling,
  configureClients
]
configure.map((config) => config(app))

module.exports = app
