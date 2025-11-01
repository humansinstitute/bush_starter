## Coding Style & Naming Conventions

YOU SHOULD GIT COMMIT EACH CHANGE YOU MAKE WITH A DESCRIPTIVE NAME

NEVER PUSH CHANGES TO GIT - I  WILL DO THAT MANUALLY AFTER CHANGING.

Tell me in your wrap up message what the git commit message was. 

TypeScript is the default; prefer ESM imports and explicit extensions when needed (`./foo.ts`). Use two-space indentation, trailing semicolons, and single quotes only inside template literals. Name files with kebab-case, classes/types with PascalCase, and functions or variables in camelCase. Co-locate agent helpers under `src/agents/` and UI utilities under `src/ui/` to keep files under 400 lines. Follow the strict TypeScript configuration in `tsconfig.json`; address compiler warnings before committing.

DONT RUN TESTS. THEY DONT HELP -> WE TEST MANUALLY AROUND HERE.

Keep changes tightly scoped: satisfy the request with the smallest viable diff unless the user explicitly asks for broader refactors.

When summarising your activity, please state what can be tested currently and if there is remaining work to complete. 

## Custom Wallet Architecture

- Treat the wallet app as front end only for business logic; keep new network
  calls, state management, and rendering in the client. The Bun server in
  `src/index.ts` should only be touched to expose additional static assets or
  adjust existing routes (for example, when a new stylesheet is added).
- Always integrate with the existing client in `src/ctxcn/CashubashClient.ts` to reach wallet services through contextv/mcp.
- When a user wants a new wallet, create a fresh front end skin that reuses that same client layer rather than building duplicate service code.
- Lightning invoices must always be rendered from client data that flows through `CashubashClient`; do not reimplement invoice services locally.

## Lightning Invoice UX

- Depend on the bundled `qrcode` package to render any BOLT11 invoice as a QR code on the front end.
- Generate QR content by calling `import QRCode from 'qrcode';` and using `QRCode.toDataURL(invoice)` (or `toCanvas` for direct DOM rendering) within UI components.
- Provide a visible fallback (copyable invoice string) for accessibility while keeping the QR code as the primary display.
- Keep QR generation encapsulated in front end utilities (for example, `src/ui/qr.ts`) so multiple wallet skins can reuse the same logic.

## Testing Guidelines

Place unit tests beside the code (`feature.test.ts`) or in a sibling `__tests__` folder. Mock subprocesses via lightweight stubs rather than spawning real CLIs. Keep coverage meaningful around session lifecycle code (`ProcessManager`), especially port allocation and cleanup. Add regression tests when modifying API contracts in `src/index.ts`.

## Commit & Pull Request Guidelines

Write imperative, present-tense commit subjects ≤72 characters (e.g., `Add process log streaming guard`). Separate logical changes into individual commits. PRs should describe scope, risks, and any configuration changes (env vars, ports). Link issues when relevant and include screenshots for UI tweaks (`/home`, `/live`).

Default to using Bun instead of Node.js.

- Use `bun <file>` instead of `node <file>` or `ts-node <file>`
- Use `bun test` instead of `jest` or `vitest`
- Use `bun build <file.html|file.ts|file.css>` instead of `webpack` or `esbuild`
- Use `bun install` instead of `npm install` or `yarn install` or `pnpm install`
- Use `bun run <script>` instead of `npm run <script>` or `yarn run <script>` or `pnpm run <script>`
- Bun automatically loads .env, so don't use dotenv.

## APIs

- `Bun.serve()` supports WebSockets, HTTPS, and routes. Don't use `express`.
- `bun:sqlite` for SQLite. Don't use `better-sqlite3`.
- `Bun.redis` for Redis. Don't use `ioredis`.
- `Bun.sql` for Postgres. Don't use `pg` or `postgres.js`.
- `WebSocket` is built-in. Don't use `ws`.
- Prefer `Bun.file` over `node:fs`'s readFile/writeFile
- Bun.$`ls` instead of execa.


## Frontend

Use HTML imports with `Bun.serve()`. Don't use `vite`. HTML imports fully support React, CSS, Tailwind.

Server:

```ts#index.ts
import index from "./index.html"

Bun.serve({
  routes: {
    "/": index,
    "/api/users/:id": {
      GET: (req) => {
        return new Response(JSON.stringify({ id: req.params.id }));
      },
    },
  },
  // optional websocket support
  websocket: {
    open: (ws) => {
      ws.send("Hello, world!");
    },
    message: (ws, message) => {
      ws.send(message);
    },
    close: (ws) => {
      // handle close
    }
  },
  development: {
    hmr: true,
    console: true,
  }
})
```

HTML files can import .tsx, .jsx or .js files directly and Bun's bundler will transpile & bundle automatically. `<link>` tags can point to stylesheets and Bun's CSS bundler will bundle.

```html#index.html
<html>
  <body>
    <h1>Hello, world!</h1>
    <script type="module" src="./frontend.tsx"></script>
  </body>
</html>
```

With the following `frontend.tsx`:

```tsx#frontend.tsx
import React from "react";

// import .css files directly and it works
import './index.css';

import { createRoot } from "react-dom/client";

const root = createRoot(document.body);

export default function Frontend() {
  return <h1>Hello, world!</h1>;
}

root.render(<Frontend />);
```

Then, run index.ts

```sh
bun --hot ./index.ts
```

For more information, read the Bun API docs in `node_modules/bun-types/docs/**.md`.
