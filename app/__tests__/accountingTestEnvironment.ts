// Tests never use deployed accounting credentials or the configured database.
// Every provider request and database operation in integration tests is mocked.
process.env.DATABASE_URL =
  "postgresql://test:test@127.0.0.1:1/smartbill_test?connect_timeout=1";
process.env.SHOPIFY_API_KEY = "00000000000000000000000000000000";
process.env.SHOPIFY_API_SECRET = "test-shopify-secret-for-unit-tests";
process.env.SHOPIFY_APP_URL = "https://app.example";
process.env.XERO_CLIENT_ID = "test-xero-client";
process.env.XERO_CLIENT_SECRET = "test-xero-secret";
process.env.QB_CLIENT_ID = "test-quickbooks-client";
process.env.QB_CLIENT_SECRET = "test-quickbooks-secret";
process.env.QB_ENVIRONMENT = "production";
process.env.ACCOUNTING_TOKEN_KEY = Buffer.alloc(32, 1).toString("base64");
