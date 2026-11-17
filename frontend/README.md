# LEVELUP English

LEVELUP English is a React/Vite learning workspace with a public marketing site,
placement assessment flow, curriculum dashboard, AI tutor UI, and Supabase Auth
integration.

## Local setup

1. Copy `.env.example` to `.env.local`.
2. Set `VITE_SUPABASE_URL` and `VITE_SUPABASE_PUBLISHABLE_KEY` to the public
   Supabase project values.
3. Install dependencies with `npm install`.
4. Start the app with `npm run dev`.

The browser only uses the public Supabase key. Service-role, AI, and payment
credentials must be kept in a server-side integration and are intentionally not
accepted as `VITE_` variables.

## Backend integrations

Run `npm run dev:full` to start both Vite and the API on port `8787`.

- `POST /api/tutor` authenticates the Supabase bearer token, loads the user's
  profile/progress, enforces daily plan limits, calls the configured
  OpenAI-compatible provider, and stores both messages in Supabase.
- `POST /api/exams/start` creates an owned, expiring attempt and returns
  question prompts without answer keys. `POST /api/exams/submit` scores against
  server-only attempt snapshots and rejects expired or duplicate submissions.
  Apply the backend migration before using these endpoints.
- `POST /api/payments/start` intentionally fails closed until an approved D17
  merchant API contract and credentials are configured. The project does not
  guess D17 endpoints or activate subscriptions from browser input.

Required server configuration is documented in `.env.example`. The backend
needs `SUPABASE_SERVICE_ROLE_KEY` and must never expose it to Vite.

This template provides a minimal setup to get React working in Vite with HMR and some ESLint rules.

Currently, two official plugins are available:

- [@vitejs/plugin-react](https://github.com/vitejs/vite-plugin-react/blob/main/packages/plugin-react) uses [Babel](https://babeljs.io/) (or [oxc](https://oxc.rs) when used in [rolldown-vite](https://vite.dev/guide/rolldown)) for Fast Refresh
- [@vitejs/plugin-react-swc](https://github.com/vitejs/vite-plugin-react/blob/main/packages/plugin-react-swc) uses [SWC](https://swc.rs/) for Fast Refresh

## React Compiler

The React Compiler is not enabled on this template because of its impact on dev & build performances. To add it, see [this documentation](https://react.dev/learn/react-compiler/installation).

## Expanding the ESLint configuration

If you are developing a production application, we recommend using TypeScript with type-aware lint rules enabled. Check out the [TS template](https://github.com/vitejs/vite/tree/main/packages/create-vite/template-react-ts) for information on how to integrate TypeScript and [`typescript-eslint`](https://typescript-eslint.io) in your project.
