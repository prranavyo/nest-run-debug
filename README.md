Nest Flow
Run and debug NestJS service methods and API routes directly from your TypeScript code. Inspect execution steps, Prisma database activity, outputs, and recorded test cases—all inside Visual Studio Code.

Nest Flow is designed for developers who want to inspect a request or service method without repeatedly setting up manual test inputs or adding temporary logging.
Features
- Run a service method — open a form for the method's parameters, provide inputs, and inspect the result.
- Send an API request — run supported NestJS controller routes with path parameters, query parameters, headers, an optional bearer/login token, and a JSON body.
- Inspect execution details — review inputs, captured Prisma database queries, calls to other services where available, output, timing, and console output.
- Debug interactively — run a method or route under the VS Code debugger, step through code, and inspect variables.
- Save and replay cases — save named inputs in your project, run cases again, and compare results.
- Generate Jest tests — create a Jest test from a recorded service-method run or API-route run.
- Mask likely secrets — sensitive-looking values are hidden in results by default, with an option to reveal them during local debugging.
- Reuse a warm process — optionally keep the application process ready to make repeat service runs faster.
Database tracing note: Prisma query tracing is supported. Other ORMs, including TypeORM and MikroORM, are not currently instrumented for database-query tracing.

Requirements
- Visual Studio Code 1.85.0 or later.
- Node.js 18 or later.
- A NestJS TypeScript project.
- ts-node and tsconfig-paths installed in the target NestJS project:
  npm install --save-dev ts-node tsconfig-paths
- A configured NestJS application and its required environment variables.
For generated API-route Jest tests, install supertest and its types in the target project:
npm install --save-dev supertest @types/supertest
Getting started
1. Install Nest Flow from the Visual Studio Code Extensions view by searching for Nest Flow.
2. Open your NestJS project as a folder/workspace in VS Code.
3. Make sure the project dependencies and environment variables are configured.
4. Open a TypeScript service or controller file.
5. Use the Run / Debug CodeLens action above a supported method or route. You can also use the Command Palette commands Nest: Run / Send Request (at cursor) and Nest: Debug (at cursor) when your cursor is on a supported target.
Nest Flow locates the target project by looking for the nearest parent package.json above the selected TypeScript file.
Run a service method
1. Open a service file containing a method in a class decorated with @Injectable().
2. Select Run above the method.
3. Fill in the parameter form and run it.
4. Inspect the captured inputs, execution information, database activity where supported, console output, and returned result.
Input fields are inferred from TypeScript parameter types where possible:
- string — text input.
- number — number input.
- boolean — true/false input.
- DTOs, objects, and arrays — JSON input.
- Untyped or any parameters — text by default; choose another input type in the form when needed.
Send an API request
1. Open a NestJS controller file.
2. Select Send request above a supported route.
3. Provide any required path parameters, query parameters, headers, login/bearer token, and JSON body.
4. Send the request and inspect the HTTP status, response body, and captured execution/database information.
Nest Flow supports standard NestJS controller prefixes and the @Get, @Post, @Put, @Patch, @Delete, @Head, @Options, and @All decorators when route paths can be resolved from string literals. If your application uses a global prefix, the runner starts the app through the configured main file so the normal NestJS bootstrap configuration can be applied.

When a DTO body can be inferred, Nest Flow attempts to provide a starter JSON body. Review and adjust the request data before sending it.
Debug a method or route
Choose Debug above a supported method or route. Nest Flow starts a debug session and pauses in the selected code so you can use the standard VS Code debugger controls:
- F5 — continue.
- F10 — step over.
- F11 — step into.
- Shift+F5 — stop debugging.
You can inspect variables while paused. When execution completes, review the run report in the Nest Flow panel.
Saved cases
You can save named input sets such as valid login or wrong password, then load and run them again. Cases are stored in your project under:
.nest-run/cases/
The Run all action runs the saved cases and compares available recorded results. You may also save a case together with its result to support later comparisons.

Review cases before committing or sharing them. Nest Flow detects likely secret fields and asks before saving them; you can omit those values. Login tokens and the Authorization header are not written into the saved case files. The login token is stored in VS Code secret storage.
Generate Jest tests
Run a method or route first, then choose Create Jest test from the result view.
- Service method: generates a .spec.ts file next to the source file.
- API route: generates an .e2e-spec.ts file using the NestJS application module and Supertest.
Generated tests are starting points. Review the test data, mocks, imports, and assertions to make sure they match your project's test setup. If Jest cannot resolve imports beginning with src/, you may need a moduleNameMapper entry in your Jest configuration, for example:
{
  "moduleNameMapper": {
    "^src/(.*)$": "<rootDir>/$1"
  }
}
API-route tests require supertest and @types/supertest in the target project.
Secrets and database safety
- Likely passwords, tokens, hashes, API keys, cookies, and database credentials are masked in reports by default.
- Use Show secrets only when needed during local development.
- Automatic secret detection uses patterns and property names; it cannot identify every secret in arbitrary text. Do not share logs, screenshots, reports, or saved cases without reviewing them.
- Runs execute your application code and can perform real database writes. There is no automatic rollback or dry-run mode. Use a local, test, or isolated development database—not production data.
- The nestRun.productionWords setting can prompt before running when configured words are found in the database host/name. This is an additional warning, not a guarantee that a database is safe.
Settings
Open Settings in VS Code and search for nestRun to configure these options.
Setting	Default	Description
nestRun.appModule	src/app.module	Path to the NestJS AppModule file, without the .ts extension.
nestRun.mainFile	src/main	Path to the application's main file, without .ts. Used to start the application for API requests.
nestRun.productionWords	prod, live	Words used to decide when to ask before running against a potentially production database host/name.
nestRun.fastMode	false	When enabled, skips the normal type-checking step for faster startup. Type errors may not be reported during startup.
nestRun.keepWarm	true	Keeps the application process warm for repeat service runs. It restarts after a file is saved. Debug sessions start a fresh process.
nestRun.executionTimeoutMs	30000	Maximum time for a normal service-method run, in milliseconds. Debug runs are not automatically timed out.
nestRun.httpTimeoutMs	30000	Maximum time for an HTTP request made by the runner, in milliseconds.
nestRun.startupTimeoutMs	60000	Maximum time allowed for the target application to start, in milliseconds.


Known limitations
- Prisma is the currently supported ORM for database-query tracing. Other ORMs may run application code, but their database queries are not currently instrumented.
- Route discovery relies on statically resolvable controller prefixes and route paths. Routes built from dynamic runtime expressions may not appear.
- Secret masking is best-effort and is not a substitute for protecting credentials or reviewing output before sharing.
- Nest Flow does not roll back database mutations made by a run.
Troubleshooting
The runner reports a missing dependency

Install the missing dependency in your target NestJS project. In particular, confirm ts-node and tsconfig-paths are installed.

The Nest application does not start

Check your AppModule path, main-file path, environment variables, database connectivity, and any application bootstrap errors. Confirm that the project runs normally outside Nest Flow.

Imports or path aliases fail

Check the target project's TypeScript configuration and ensure its runtime tooling supports the aliases used by your app.

A route does not appear

Confirm the class uses @Controller() and the handler uses a supported HTTP decorator with a statically resolvable string path.

A generated Jest test fails

Review the generated imports, module mocks, Jest configuration, and any required src/ path mappings. Install Supertest for API-route tests.
Development
To run the extension from source:
git clone https://github.com/prranavyo/nest-run-debug.git
cd nest-run-debug
npm install
npm run compile
Open the repository folder in VS Code and press F5 to launch an Extension Development Host. In that new window, open a NestJS project and try Nest Flow on a supported service method or controller route.

License
This project is distributed under the MIT LICENSE.