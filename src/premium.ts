// Reverse lane — x402-style agent payments over PayPal (not crypto).
// An agent that wants premium data gets HTTP 402 with a PayPal invoice
// instead of a wallet address; it pays with a PayPal Order, then retries
// with the order id. The bridge verifies the order against the Orders API
// and serves the content. Agent → bridge → human, both directions settled
// through PayPal.

import type { Env } from "./types";

const PRICE = { value: "0.01", currency_code: "USD" };
// The sandbox business account that receives agent payments.
const RECEIVER = "sb-hp8xg48048392@business.example.com";

const invoiceHeaders = (orderId?: string) => ({
  "X-Payment-Required": "paypal",
  "X-Payment-Invoice": JSON.stringify({
    amount: PRICE.value,
    currency: PRICE.currency_code,
    receiver: RECEIVER,
    ...(orderId ? { order_id: orderId } : {}),
  }),
  "WWW-Authenticate": 'PayPal realm="slopcash-premium"',
});

function paymentRequired(env: Env, repo: string): Response {
  const invoice = {
    x402Version: 2,
    error: "payment-required",
    message:
      "This resource is behind a PayPal paywall. Create a PayPal order for the invoice amount (sandbox OK), approve it, then retry with ?order=<ORDER_ID>.",
    invoice: {
      amount: PRICE.value,
      currency: PRICE.currency_code,
      receiver: RECEIVER,
      memo: `slopcash premium export ${repo}`,
      create_order: `${env.PAYPAL_API_BASE}/v2/checkout/orders`,
      approve_url_hint: "https://www.sandbox.paypal.com/checkoutnow?token=<ORDER_ID>",
      retry_with: `?repo=${repo}&order=<ORDER_ID>`,
    },
  };
  const body = JSON.stringify(invoice, null, 2);
  return new Response(body, {
    status: 402,
    headers: {
      "content-type": "application/json",
      // x402 v2 http transport: PaymentRequired travels base64 in a header.
      "PAYMENT-REQUIRED": btoa(unescape(encodeURIComponent(body))),
      ...invoiceHeaders(),
    },
  });
}

interface Order {
  id?: string;
  status?: string;
  purchase_units?: { amount?: { value?: string; currency_code?: string } }[];
}

async function orderPaid(env: Env, orderId: string): Promise<Order | null> {
  if (!env.PAYPAL_CLIENT_ID || !env.PAYPAL_CLIENT_SECRET) return null;
  const tokenRes = await fetch(`${env.PAYPAL_API_BASE}/v1/oauth2/token`, {
    method: "POST",
    headers: {
      authorization: `Basic ${btoa(`${env.PAYPAL_CLIENT_ID}:${env.PAYPAL_CLIENT_SECRET}`)}`,
      "content-type": "application/x-www-form-urlencoded",
    },
    body: "grant_type=client_credentials",
  });
  if (!tokenRes.ok) return null;
  const { access_token } = (await tokenRes.json()) as { access_token: string };
  const res = await fetch(`${env.PAYPAL_API_BASE}/v2/checkout/orders/${orderId}`, {
    headers: { authorization: `Bearer ${access_token}` },
  }).catch(() => null);
  if (!res || !res.ok) return null;
  const order = (await res.json()) as Order;
  const amount = order.purchase_units?.[0]?.amount;
  const paid =
    (order.status === "APPROVED" || order.status === "COMPLETED") &&
    amount?.value === PRICE.value &&
    amount?.currency_code === PRICE.currency_code;
  return paid ? order : null;
}

/**
 * GET /api/premium/oplog-export?repo=owner/name[&order=<id>]
 * 402 → create/approve a PayPal order → retry with ?order → signed
 * provenance bundle (the forge's /dg/export) is served.
 */
export async function handlePremiumExport(req: Request, env: Env): Promise<Response> {
  const url = new URL(req.url);
  const repo = url.searchParams.get("repo") ?? "";
  const orderId = url.searchParams.get("order")
    ?? req.headers.get("PAYMENT-SIGNATURE")   // x402 v2
    ?? req.headers.get("X-PAYMENT")           // x402 v1
    ?? "";
  if (!/^[a-z0-9-]+\/[a-z0-9-]+$/i.test(repo)) {
    return Response.json({ error: "repo must look like owner/repo" }, { status: 400 });
  }
  if (!orderId) return paymentRequired(env, repo);

  const paid = await orderPaid(env, orderId);
  if (!paid) {
    return new Response(
      JSON.stringify(
        {
          error: "payment-not-verified",
          message: `Order ${orderId} is missing, unpaid, or amount != ${PRICE.value} ${PRICE.currency_code}.`,
          retry: `?repo=${repo}&order=<ORDER_ID>`,
        },
        null,
        2
      ),
      { status: 402, headers: { "content-type": "application/json", ...invoiceHeaders(orderId) } }
    );
  }

  // Paid — serve the forge's signed provenance bundle through.
  const upstream = await fetch(`${env.FORGE_BASE}/api/${repo}/dg/export`);
  return new Response(upstream.body, {
    status: upstream.status,
    headers: {
      "content-type": upstream.headers.get("content-type") ?? "application/json",
      "X-Paid-Order": paid.id ?? orderId,
      "X-Payment-Settled": "paypal",
    },
  });
}
