import {
  json,
  type ActionFunctionArgs,
  type LoaderFunctionArgs,
} from "@remix-run/node";
import {
  Form,
  useActionData,
  useLoaderData,
  useNavigation,
} from "@remix-run/react";
import {
  accountingReturnUrl,
  authorizedBrowser,
  confirmAuthorization,
} from "../services/accountingAuthorization.server";
export async function loader({ request }: LoaderFunctionArgs) {
  try {
    const id = new URL(request.url).searchParams.get("authorization") || "";
    const row = await authorizedBrowser(request, id, "SELECTING");
    return json(
      {
        id,
        platform: row.platform,
        environment: row.environment,
        shop: row.shop,
        companies: row.companies as { id: string; name: string }[],
        returnUrl: accountingReturnUrl(row.shop),
      },
      {
        headers: {
          "Cache-Control": "no-store",
          "Referrer-Policy": "no-referrer",
        },
      },
    );
  } catch (error) {
    throw new Response(
      error instanceof Error ? error.message : "Connection expired.",
      { status: 400 },
    );
  }
}
export async function action({ request }: ActionFunctionArgs) {
  try {
    const form = await request.formData();
    return await confirmAuthorization(
      request,
      String(form.get("authorization")),
      String(form.get("companyId")),
    );
  } catch (error) {
    return json(
      {
        error: error instanceof Error ? error.message : "Confirmation failed.",
      },
      { status: 400 },
    );
  }
}
export default function ConfirmAccounting() {
  const data = useLoaderData<typeof loader>();
  const result = useActionData<typeof action>();
  const busy = useNavigation().state !== "idle";
  return (
    <main
      style={{
        maxWidth: 620,
        margin: "64px auto",
        padding: 24,
        fontFamily: "system-ui",
      }}
    >
      <h1>
        Confirm your{" "}
        {data.platform === "XERO" ? "Xero organisation" : "QuickBooks company"}
      </h1>
      <p>
        Connect the company that should receive supplier bills from {data.shop}.
      </p>
      {data.environment === "sandbox" && (
        <p>
          <strong>QuickBooks sandbox — test company only.</strong>
        </p>
      )}
      {result?.error && <p role="alert">{result.error}</p>}
      <Form method="post">
        <input type="hidden" name="authorization" value={data.id} />
        <label>
          Accounting company{" "}
          <select name="companyId" required defaultValue="">
            <option value="" disabled>
              Choose a company
            </option>
            {data.companies.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        </label>
        <p>
          New connections require account and tax defaults to be selected in
          Settings. Existing exports stay associated with their original
          company.
        </p>
        <button type="submit" disabled={busy}>
          {busy ? "Connecting…" : "Confirm connection"}
        </button>
      </Form>
      <p>
        <a href={data.returnUrl}>Return to SmartBill</a>
      </p>
    </main>
  );
}
