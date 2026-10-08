# Step 5 · Add the linking page to Ghost

!!! abstract ""
    **You need:** the Worker URL from [step 2](2-deploy.md), Ghost Admin access (and nginx access for option A) · **You get:** a "Get my Discord code" page for your members · **Time:** 10 min

This is the page members visit to get their linking code. It holds a small widget that asks Ghost for the member's signed entitlement token, sends it to the Worker's `/code` endpoint and shows the code with a copy button and a 10-minute countdown.

## 5.1 Choose how the widget reaches the Worker

=== "A · Through nginx (recommended)"

    The browser calls `https://<your-site>/code`, and nginx forwards it to the Worker. The call is same-origin (no CORS), and the Worker hostname stays out of sight.

    Add this block to the `server { }` block that serves your Ghost site, replacing `<worker-subdomain>` (for example `ghost-discord-worker.myaccount`):

    ```nginx
    --8<-- "nginx-code.conf"
    ```

    Then validate and reload:

    ```sh
    sudo nginx -t && sudo systemctl reload nginx
    ```

    Keep `CODE_URL = "/code"` in the widget (the default).

    !!! warning "Keep the `resolver` lines"
        Without them nginx resolves `workers.dev` once at startup; when Cloudflare changes its IPs, `/code` starts failing with `502` after a few hours.

=== "B · Direct to the Worker"

    No server change. The browser calls the Worker URL directly, which works thanks to the CORS headers the Worker sends for `GHOST_URL`.

    In the widget below, change this line:

    ```js
    const CODE_URL = "/code";
    ```

    to your Worker URL:

    ```js
    const CODE_URL = "https://ghost-discord-worker.<account>.workers.dev/code";
    ```

    `GHOST_URL` must match the site origin exactly (scheme, `www`, no trailing slash), or the browser blocks the call.

## 5.2 Create the page in Ghost

1. In **Ghost Admin → Pages**, click **New page**.
2. Title it, for example *Discord access*, and add a short intro: *"Link your Discord account to get your member roles."*
3. Click **+** to add a card and choose **HTML**.
4. Paste the whole widget code from 5.3 into the card (with your `CODE_URL` change if you chose option B).
5. Open the page settings (gear icon, top right):
    - **Page URL**: `discord` → the page lives at `https://<your-site>/discord/`
    - **Page access**: *Members only* (recommended: visitors who are not signed in see Ghost's sign-up call to action instead of the widget)
6. Click **Publish**.
7. Optional: add the page to your menu in **Settings → Navigation**.

## 5.3 Widget code

Copy it with the button at the top right of the block.

```html
--8<-- "discord-widget.html"
```

The widget only uses `textContent` to display values (no HTML injection) and needs no external script. Adjust the colours in the `<style>` block to match your theme.

## Check before moving on

- [ ] **Signed out**, `https://<your-site>/discord/` shows Ghost's sign-up prompt (members-only page), or the widget's *"Please sign in…"* message when you click the button.
- [ ] **Signed in** as a member, clicking **Get my Discord code** shows an 8-character code and a countdown.
- [ ] Clicking again returns the **same** code: the Worker keeps one live code per member.

If clicking shows an error, see the troubleshooting table at [step 6](6-test.md#troubleshooting).

[Next: Test & go live :material-arrow-right:](6-test.md){ .md-button .md-button--primary }
