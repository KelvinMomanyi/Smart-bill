# Shopify local requirements matrix — 16 October 2026

Fetched with the official Shopify CLI from [the current AI self-review checklist](https://shopify.dev/docs/apps/launch/app-store-review/app-store-ai-self-review-requirements). Checklist SHA-256: `8344cf11677e42569e83f4ca5c94317ead3abaece18ab3aae21c0f6cfc5488d0`.

100 entries accounted for: **25 likely passing, 0 likely failing, 6 needing review, 69 skipped across 10 category groups**. These are local checklist assessments; they do not certify deployed compliance or assess every broader requirement. See [the readiness report](SHOPIFY_RESUBMISSION_2026-10-16.md) for security, deployment, functionality and listing blockers.

| Requirement | Assessment | Evidence / acceptance remaining |
| --- | --- | --- |
| 1.1.1 Use session tokens for authentication | Needs review | Session-token authentication exists; a real authenticated Chrome incognito run with third-party cookies blocked remains unverified. |
| 1.1.2 Use Shopify checkout | Likely passing | No customer checkout or off-platform customer-payment processing detected. |
| 1.1.3 Direct merchants to the Shopify Theme Store | Likely passing | No theme installation or download functionality detected. |
| 1.1.4 Use only factual information | Needs review | No fabricated storefront data detected. Compare the actual Dashboard listing, integrations, screenshots and prices with the deployed release. |
| 1.1.6 Build single-merchant storefronts. Marketplaces should be sales channels | Likely passing | Tenant-scoped supplier invoices and vendor records; no independent seller marketplace detected. |
| 1.1.7 Always build Payment Gateway apps using the Payments API and after obtaining authorization | Likely passing | No payment gateway or payment-processing extension detected. |
| 1.1.8 Build apps for Shopify POS only, not third-party systems | Likely passing | No third-party POS integration detected; Xero/QuickBooks are accounting integrations. |
| 1.1.9 Obtain explicit buyer consent before adding charges | Likely passing | No buyer-cart charges or checkout modifications detected. |
| 1.1.10 Maintain the cheapest shipping option as default | Likely passing | No shipping-option manipulation detected. |
| 1.1.13 Duplicate only authorized product information | Likely passing | Product queries use the authenticated merchant Admin API; no other-store catalog-copying feature detected. |
| 1.1.14 Don't connect merchants to external agencies and developers | Likely passing | Support contact belongs to the app operator; no agency/freelancer marketplace detected. |
| 1.1.15 Process refunds only through the original payment processor | Likely passing | Supplier credit-note allocation is bookkeeping; no customer refund/payment-processor logic detected. |
| 1.1.16 Don't provide capital lending | Likely passing | No lending, cash-advance or financing feature detected. |
| 1.2.1 Use Shopify App Pricing or the Shopify Billing API | Likely passing | Shopify SDK billing.request and central recurring plan configuration; no external app-charge integration detected. |
| 1.2.2 Implement Shopify App Pricing or the Shopify Billing API correctly | Needs review | Fixed ACTIVE test-charge recognition and passed isolated approval/decline/reinstall browser scenarios. Fresh hosted approval and reinstall on the deployed fix remain unverified. |
| 1.2.3 Allow pricing plan changes | Needs review | In-app Starter/Growth replacements pass browser tests with simulated Shopify responses. Verify actual charge history and both transitions after deploying. |
| 2.2.1 Use Shopify APIs | Likely passing | Shopify SDK initialization, authenticated GraphQL product/inventory queries and cost mutations exist. |
| 2.2.3 Use the latest version of Shopify App Bridge | Likely passing | Shopify Remix AppProvider emits the CDN App Bridge script before app children; no legacy @shopify/app-bridge dependency. |
| 2.2.4 Use the GraphQL Admin API | Likely passing | Admin GraphQL operations validate with configured 2026-10 schema; no general REST Admin calls detected. |
| 2.2.6 Don't display promotions or advertisements in admin extensions | Likely passing | Authenticated app info reports no extension configuration files; no admin-extension advertising detected. |
| 2.2.7 Only launch Max modal with merchant interaction | Likely passing | No automatic Max modal/fullscreen launches detected. |
| 2.3.1 Initiate installation from a Shopify-owned surface | Likely passing | No manual shop-domain form; installation links point to Shopify-owned listing or supplied installation flow. |
| 2.3.2 Authenticate immediately after install | Likely passing | Protected loaders/actions use authenticate.admin; SDK handles managed OAuth/token exchange before merchant data access. |
| 2.3.3 Redirect to the app UI after installation | Needs review | SDK and store-specific embedded navigation are implemented and tested locally. Actual fresh-install destination remains unverified. |
| 2.3.4 Require OAuth authentication immediately after reinstall | Needs review | Uninstall removes sessions and the SDK reacquires tokens. Actual reinstall needs a suitable test installation without deleting existing merchant connections. |
| 3.1.1 Use a valid TLS/SSL certificate | Likely passing | Public production app/privacy/terms loaded successfully over validated HTTPS in HTTP and Playwright MCP checks. |
| 3.2.1 Request read_all_orders access scope only if it provides necessary app functionality | Likely passing | read_all_orders is absent from configured scopes. |
| 3.2.2 Request write_payment_mandate scope only if it provides necessary app functionality | Likely passing | write_payment_mandate is absent from configured scopes. |
| 3.2.3 Request write_checkout_extensions_apis scope only if it provides necessary app functionality | Likely passing | write_checkout_extensions_apis is absent from configured scopes. |
| 3.2.4 Request read_advanced_dom_pixel_events scope only if it provides necessary app functionality | Likely passing | read_advanced_dom_pixel_events is absent from configured scopes. |
| 3.2.5 Request read_checkout_extensions_chat scope only when required | Likely passing | read_checkout_extensions_chat is absent from configured scopes. |
| 5.1.1 Use theme app extensions | Skipped | Category gate not present or category opt-in not requested. |
| 5.1.3 Include detailed onboarding instructions for theme app extensions | Skipped | Category gate not present or category opt-in not requested. |
| 5.1.5 Send collected data back to the merchant | Skipped | Category gate not present or category opt-in not requested. |
| 5.2.4 Use correct payment API scopes | Skipped | Category gate not present or category opt-in not requested. |
| 5.2.5 Build payment apps as standalone, not embedded | Skipped | Category gate not present or category opt-in not requested. |
| 5.2.6 Allow buyers to cancel/abandon payment with the payment gateway | Skipped | Category gate not present or category opt-in not requested. |
| 5.2.7 Redirect merchants back to the Shopify admin using the proper URL | Skipped | Category gate not present or category opt-in not requested. |
| 5.2.10 Display only Shopify-approved payment methods | Skipped | Category gate not present or category opt-in not requested. |
| 5.2.11 Offer a test mode | Skipped | Category gate not present or category opt-in not requested. |
| 5.2.12 Don't upsell any product or features in the payment flow | Skipped | Category gate not present or category opt-in not requested. |
| 5.2.13 Appropriately name payment apps | Skipped | Category gate not present or category opt-in not requested. |
| 5.3.3 Must be free for merchants | Skipped | Category gate not present or category opt-in not requested. |
| 5.4.2 Use correct subscription API scopes | Skipped | Category gate not present or category opt-in not requested. |
| 5.4.3 Don't use incorrect API scopes for purchase option apps | Skipped | Category gate not present or category opt-in not requested. |
| 5.4.5 Allow buyers to modify subscription payment methods | Skipped | Category gate not present or category opt-in not requested. |
| 5.4.6 Enable merchants to create and manage selling plans from the product page and choose products for subscriptions | Skipped | Category gate not present or category opt-in not requested. |
| 5.4.7 Include access to your subscription portal through Shopify's customer portal | Skipped | Category gate not present or category opt-in not requested. |
| 5.4.8 Enable buyers to cancel their purchase option, or clearly communicate cancellation conditions | Skipped | Category gate not present or category opt-in not requested. |
| 5.4.9 Navigate buyers to the customer portal | Skipped | Category gate not present or category opt-in not requested. |
| 5.4.10 Display purchase options and charge timing clearly | Skipped | Category gate not present or category opt-in not requested. |
| 5.4.12 Link subscriptions directly to the linked Customers in Shopify Admin | Skipped | Category gate not present or category opt-in not requested. |
| 5.4.13 Show buyers all of their purchased subscriptions in the Customer portal clearly | Skipped | Category gate not present or category opt-in not requested. |
| 5.4.14 Update multi-currency pricing and discount codes correctly on the product page | Skipped | Category gate not present or category opt-in not requested. |
| 5.4.15 Link subscriptions directly to the linked Orders in Shopify Admin | Skipped | Category gate not present or category opt-in not requested. |
| 5.4.16 Display selling plan name in the Cart page | Skipped | Category gate not present or category opt-in not requested. |
| 5.4.17 Communicate pre-order delays with pre-stated shipment times to buyers | Skipped | Category gate not present or category opt-in not requested. |
| 5.4.18 Clearly indicate details for prepaid items, including unit price, length of subscription, and price per delivery | Skipped | Category gate not present or category opt-in not requested. |
| 5.4.19 Enable variant-level product selection for buyers | Skipped | Category gate not present or category opt-in not requested. |
| 5.5.1 Enable merchants to request fulfillment | Skipped | Category gate not present or category opt-in not requested. |
| 5.5.2 Include details of cost of goods sold | Skipped | Category gate not present or category opt-in not requested. |
| 5.5.5 Verify payment before marking orders as fulfilled | Skipped | Category gate not present or category opt-in not requested. |
| 5.6.2 Give merchants full control over promotional content | Skipped | Category gate not present or category opt-in not requested. |
| 5.6.3 Don't display self-promotion or advertisements in checkout extensions | Skipped | Category gate not present or category opt-in not requested. |
| 5.6.5 Get explicit customer consent prior to making any changes that affect the order total in any way | Skipped | Category gate not present or category opt-in not requested. |
| 5.6.6 Don't add countdown timers to the checkout | Skipped | Category gate not present or category opt-in not requested. |
| 5.6.7 Use Chat UI components for customer service | Skipped | Category gate not present or category opt-in not requested. |
| 5.6.9 Don't request payment information in checkout UI extension | Skipped | Category gate not present or category opt-in not requested. |
| 5.7.2 Build with Polaris components and style guide | Skipped | Category gate not present or category opt-in not requested. |
| 5.7.4 Provide details in the publishing section | Skipped | Category gate not present or category opt-in not requested. |
| 5.7.5 Provide the marketplace link in the channel interface | Skipped | Category gate not present or category opt-in not requested. |
| 5.7.6 Communicate commission | Skipped | Category gate not present or category opt-in not requested. |
| 5.7.7 Open terms and conditions in a new window | Skipped | Category gate not present or category opt-in not requested. |
| 5.7.8 Use banners for approval or rejection of products | Skipped | Category gate not present or category opt-in not requested. |
| 5.7.9 Use Polaris cards in the publishing section | Skipped | Category gate not present or category opt-in not requested. |
| 5.7.10 Redirect to the account section after install | Skipped | Category gate not present or category opt-in not requested. |
| 5.7.11 Provide error feedback in the publishing section | Skipped | Category gate not present or category opt-in not requested. |
| 5.7.12 Must allow merchants to disconnect their account | Skipped | Category gate not present or category opt-in not requested. |
| 5.7.13 Display account information properly | Skipped | Category gate not present or category opt-in not requested. |
| 5.7.15 Must communicate account approval process | Skipped | Category gate not present or category opt-in not requested. |
| 5.7.16 Use Sales Attribution | Skipped | Category gate not present or category opt-in not requested. |
| 5.7.17 Communicate eligibility issues | Skipped | Category gate not present or category opt-in not requested. |
| 5.8.1 Add the `write_checkout_extensions_apis` scope | Skipped | Category gate not present or category opt-in not requested. |
| 5.8.2 Ensure the upsell is transparent to the buyer and include accept and decline buttons | Skipped | Category gate not present or category opt-in not requested. |
| 5.8.3 Show the same product information on post purchase upsell | Skipped | Category gate not present or category opt-in not requested. |
| 5.8.4 Limit consecutive requests displayed to customers | Skipped | Category gate not present or category opt-in not requested. |
| 5.8.5 Correctly assign the purchase option category for each selling plan created | Skipped | Category gate not present or category opt-in not requested. |
| 5.8.6 Redirect to the order confirmation page when done | Skipped | Category gate not present or category opt-in not requested. |
| 5.8.7 Use the calloutbanner component to display callout banners | Skipped | Category gate not present or category opt-in not requested. |
| 5.8.8 Update price breakdown to reflect price changes | Skipped | Category gate not present or category opt-in not requested. |
| 5.8.9 Don't display third party ads or promotions | Skipped | Category gate not present or category opt-in not requested. |
| 5.8.10 Exclude order tracking/status from your post purchase page | Skipped | Category gate not present or category opt-in not requested. |
| 5.9.2 Include submission info for the Apple App Store and Google Play | Skipped | Category gate not present or category opt-in not requested. |
| 5.9.3 Provide app theme customization or presets | Skipped | Category gate not present or category opt-in not requested. |
| 5.10.1 Give instruction on how to hide add-to-cart on donation products | Skipped | Category gate not present or category opt-in not requested. |
| 5.10.2 Provide merchants with proof of donation | Skipped | Category gate not present or category opt-in not requested. |
| 5.10.3 Indicate operating cost in UI and listing | Skipped | Category gate not present or category opt-in not requested. |
| 5.10.5 Use a theme app block to add donation products | Skipped | Category gate not present or category opt-in not requested. |
| 5.10.6 Collect donation funds using PCI-compliant third party gateways or the Billing API | Skipped | Category gate not present or category opt-in not requested. |
| 5.10.7 Process customer’s donations through Shopify Checkout | Skipped | Category gate not present or category opt-in not requested. |

## Skipped groups

- 5.1 Online store (3 entries): no matching extension type or required scopes detected; authenticated app info reports no extensions.
- 5.2 Payment (8 entries): no matching extension type or required scopes detected; authenticated app info reports no extensions.
- 5.3 Payment facilitator (1 entries): opt-in category review was not specifically requested; no matching app functionality detected.
- 5.4 Purchase option (16 entries): no matching extension type or required scopes detected; authenticated app info reports no extensions.
- 5.5 Product sourcing (3 entries): opt-in category review was not specifically requested; no matching app functionality detected.
- 5.6 Checkout customization (6 entries): no matching extension type or required scopes detected; authenticated app info reports no extensions.
- 5.7 Sales channel (14 entries): no matching extension type or required scopes detected; authenticated app info reports no extensions.
- 5.8 Post purchase (10 entries): no matching extension type or required scopes detected; authenticated app info reports no extensions.
- 5.9 Mobile app builders (2 entries): opt-in category review was not specifically requested; no matching app functionality detected.
- 5.10 Donation (6 entries): opt-in category review was not specifically requested; no matching app functionality detected.

No skipped entry is counted as passing.
