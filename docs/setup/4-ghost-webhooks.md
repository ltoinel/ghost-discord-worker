# Step 4 · Configure Ghost webhooks

!!! abstract ""
    **You need:** the Worker URL and `WEBHOOK_SECRET` from [step 2](2-deploy.md) · **You get:** roles that follow subscription changes · **Time:** 5 min

Webhooks tell the Worker when a member is added, changes plan, or is deleted. Without them, roles are set once at `/link` and never updated.

## 4.1 Create a custom integration

1. In **Ghost Admin → Settings → Integrations**, click **Add custom integration**.
2. Name it, for example *Discord roles*, and click **Create**.

## 4.2 Add the three webhooks

In the integration, click **Add webhook** three times:

| Name | Event | Target URL | Secret |
|---|---|---|---|
| Discord · added | Member added | `https://<worker-url>/webhook/added` | `WEBHOOK_SECRET` |
| Discord · updated | Member updated | `https://<worker-url>/webhook/updated` | `WEBHOOK_SECRET` |
| Discord · deleted | Member deleted | `https://<worker-url>/webhook/deleted` | `WEBHOOK_SECRET` |

The **Secret** field must contain exactly the `WEBHOOK_SECRET` value from your secrets file. Ghost signs each call with it (`X-Ghost-Signature`); the Worker rejects anything else with `401`.

## Check before moving on

Open a terminal on the live logs:

```sh
npx wrangler tail
```

Then, in Ghost Admin, edit any member (change their name and save).

- [ ] The log shows `POST /webhook/updated` with **Ok**, and a line *"No Discord mapping found for email: …"*. That is the expected result: the signature is valid, the member just is not linked yet.
- [ ] If you see **401 Unauthorized** instead, the webhook **Secret** in Ghost differs from `WEBHOOK_SECRET`.

[Next: Add the linking page :material-arrow-right:](5-ghost-widget.md){ .md-button .md-button--primary }
