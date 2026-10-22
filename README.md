# Nest Run & Debug (version 0.1)

Test a NestJS service method or an API endpoint straight from your code, and see every step:
**Input → DB calls and other services → Output**, like the pipeline debug in webMethods.

## Set up
1. In this folder: `npm install` then `npm run compile`
2. Open this folder in VS Code and press **F5** (opens a new "Extension Development Host" window)
3. In that new window, open your Nest project folder
4. Open a service file and click **▶ Run**, or a controller file and click **▶ Send request**

## Your Nest project needs
`ts-node` and `tsconfig-paths` installed (`npm i -D ts-node tsconfig-paths`). The extension finds the project from
the nearest `package.json` above the file you clicked. A `.env` file with `DATABASE_URL` is used to show the database
name and for the production check.

## 1. ▶ Run a service method
A form opens in the side panel with one field per parameter (your last values are remembered).
The result shows: input, every DB call (SQL, values, rows, time), calls to the other services your method uses
(like a response helper or token service), the output, and your `console.log` lines.

- `string` → text, `number` → number, `boolean` → true/false, DTOs and arrays → JSON box.
- **No type written** (for example `userLogin(email, password)`) → text by default. Use the "as" dropdown if it should be
  a Number, True/False or JSON.

## 2. ▶ Send request (API endpoints)
A **▶ Send request** button appears above every `@Get`, `@Post`, `@Put`, `@Patch`, `@Delete` route in a controller.
- Fill in path values, query, headers, a **login token**, and a JSON body (a starter body is made from your DTO class).
- Your app starts the way your `main.ts` does (global prefix like `/api`, pipes, filters), on a free port, so it never
  clashes with your dev server. A path without a leading `/` gets the prefix added automatically.
- You see the response (status and body) and every DB call made while handling it.

## 3. 💾 Saved cases
Save a set of inputs under a name ("valid login", "wrong password") and run it again with one click.
- Cases are stored in **`.nest-run/cases/*.json`** inside your project, so your team can share them (commit the folder).
- After a run, **💾 Save case (with this result)** also stores the result. **▶ Run all** then runs every case and shows
  ✔ same result, ✖ different, or • nothing to compare.
- Secrets: if a field looks like a secret (password, token...), you are asked before it is saved, and you can save the
  case without those values. The login token and `Authorization` header are **never** saved in the file
  (the token is kept in VS Code's secret storage).

## 4. 🧪 Create Jest test
After a run, click **🧪 Create Jest test**. It writes a test file next to your code:
- service method → `<file>.<method>.spec.ts` (mocks the database and the other services with the answers it saw,
  then checks the output and what was asked of them)
- API route → `<file>.<method>.e2e-spec.ts` (uses supertest and your `AppModule`)

Values of secret-looking fields are written as `<REDACTED>`. Put your own test values there.
If Jest cannot find imports that start with `src/`, add `moduleNameMapper: { "^src/(.*)$": "<rootDir>/$1" }` to your Jest config.
For route tests install `supertest` (`npm i -D supertest @types/supertest`).

## Secrets are hidden by default
Passwords, tokens, hashes, API keys, cookies, and database credentials show as `••••••` in the result. Press **👁 Show secrets** to inspect unmasked values during local development debugging. Note: Automatic secret detection relies on established patterns (property keys, URLs, headers, bearer tokens, JWTs, and common formats); it cannot identify every arbitrary secret embedded in unstructured free text.

## 🐞 Debug
Starts the method or route under VS Code's debugger and pauses on its first line.
Use **F10** Step Over, **F11** Step Into, **F5** Continue, **Shift+F5** Stop. Hover over variables to see values.
When it finishes, the panel shows the steps and output, same as Run.

## Speed
- **Type-check** is ON by default, like a normal build. Optional **Fast mode** (`nestRun.fastMode`, off by default)
  skips it for a quicker start.
- **Keep warm** (`nestRun.keepWarm`, on by default): ▶ Run keeps your app running in the background. The first run
  (and the first one after you save a file) starts the app, which takes a few seconds. Next runs are quick.
  🐞 Debug always starts a fresh process.

## Settings
- `nestRun.appModule`: path to your AppModule, default `src/app.module`
- `nestRun.mainFile`: path to your main file, default `src/main`
- `nestRun.productionWords`: words that make it ask before running (default `prod`, `live`)
- `nestRun.fastMode`, `nestRun.keepWarm`: see Speed
- `nestRun.executionTimeoutMs`: maximum duration for a normal service run (default 30000ms)
- `nestRun.httpTimeoutMs`: maximum duration for runner HTTP requests (default 30000ms)
- `nestRun.startupTimeoutMs`: maximum duration for target app bootstrap (default 60000ms)

## Runtime Requirements and Platform Compatibility
- Requires Node.js 18 or newer (tested on Node.js 22 under Windows 11).
- Target NestJS applications must have `ts-node` and `tsconfig-paths` installed as development dependencies.
- Paths with spaces and Windows drive letters are supported.

## Known limits
- Dry run (automatic rollback of database mutations) is not supported. Runs perform actual database writes, so always use a local or isolated development database.
- Database query tracing is Prisma-specific. Other ORMs (e.g. TypeORM, MikroORM) are not currently instrumented.
- Static route resolution supports standard NestJS `@Controller` prefixes and HTTP decorators (`@Get`, `@Post`, `@Put`, `@Patch`, `@Delete`, `@Head`, `@Options`, `@All`) with string paths and literals. Routes with dynamic runtime expressions are omitted rather than guessed.
