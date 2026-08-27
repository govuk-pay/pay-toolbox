# Pay Toolbox

Internal administrative tools service for GOV.UK Pay products.

[![Known Vulnerabilities](https://snyk.io//test/github/govuk-pay/pay-toolbox/badge.svg?targetFile=package.json)](https://snyk.io//test/github/govuk-pay/pay-toolbox?targetFile=package.json)

## Running in a support role

Toolbox runs alongside other GOV.UK Pay services in `production`, `staging` and `test` environments.

## Setting up local development

Getting Toolbox up and running for development.

```bash
npm install

# build server and browser assets
npm run build

# generate a dev environment file - run the version according to your needs
node scripts/generate-dev-environment.js # default - target services running through SSH tunnel
node scripts/generate-dev-environment.js local # target services running locally on your machine
node scripts/generate-dev-environment.js docker # for docker deployment - talk to external network

# this will watch javascript files for changes and restart the server accordingly
npm run dev
```

### Debug using Visual Studio Code

* In VSCode, go to the `Debug` view (on MacOS, use shortcut `CMD + shift + D`).
* From the **Run** toolbar, select the launch config `Toolbox`.
* Press The `green play` button (`F5` MacOS). This will run the app in debug mode.
* Add breakpoints to any file you want to debug - click in the left hand column and a red dot will appear.

If the above doesn't work, try the following:

* Open the search command box and enter `Debug npm script`
* Select `dev tsc-watch --noClear --onSuccess "./scripts/run-dev"`

## Key runtime environment variables

| Variable                 | Description                                                          |
|--------------------------|:---------------------------------------------------------------------|
| `BIND_HOST`              | The IP address for the application to bind to. Defaults to 127.0.0.1 |
| `NODE_ENV`               |
| `STRIPE_ACCOUNT_API_KEY` | Defaults to `''`                                                     |
| `https_proxy`            |

## Development Goals/ Focus

* Small files, each piece responsible for one thing
* Contextual tests, tests close to what they are testing, organised by feature
* Simple to understand architecture
* Latest language development standards

## Notes on coding style restriction

See `.eslintrc.json` for specifics.

`semi` - see [Eslint referenced blogpost](https://blog.izs.me/2010/12/an-open-letter-to-javascript-leaders-regarding)

`comma-dangle` - many popular diff/review tools now allow ignoring whitespace
this should no longer be something we have to account for with hacks

`array-bracket-spacing` - opinion: :+1: spacing
`@typescript-eslint/no-var-requires` - not yet using Typescript module syntax, rule should be set to error when we
switch

## Build process (inbox)

Currently relies on `tsc-watch` to extend the Typescript compiler in dev mode, ideally this should combine `nodemon`
waiting on standard `tsc --watch`

`ts-node` is used for directly interpreting unit test files, we can either use this or include test files in the watch/
build process

## Licence

[MIT License](LICENCE)

## Vulnerability Disclosure

GOV.UK Pay aims to stay secure for everyone. If you are a security researcher and have discovered a security
vulnerability in this code, we appreciate your help in disclosing it to us in a responsible manner. Please refer to
our [vulnerability disclosure policy](https://www.gov.uk/help/report-vulnerability) and
our [security.txt](https://vdp.cabinetoffice.gov.uk/.well-known/security.txt) file for details.
