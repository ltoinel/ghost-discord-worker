# Step 5 · Deploy the widget on Ghost

<nav class="gd-stepper" aria-label="Installation progress">
  <a href="../1-discord/" class="done"><b>Step 1</b>Prepare Discord</a>
  <a href="../2-deploy/" class="done"><b>Step 2</b>Deploy the Worker</a>
  <a href="../3-connect-discord/" class="done"><b>Step 3</b>Connect Discord</a>
  <a href="../4-ghost-webhooks/" class="done"><b>Step 4</b>Ghost webhooks</a>
  <a href="../5-ghost-widget/" class="current" aria-current="step"><b>Step 5</b>Deploy the widget on Ghost</a>
  <a href="../6-test/" class=""><b>Step 6</b>Test &amp; go live</a>
</nav>

!!! abstract ""
    **You need:** the Worker URL from [step 2](2-deploy.md), access to Ghost Admin (and to your nginx config for option A) · **You get:** a "Get my Discord code" page on your site · **Time:** 10 min

The widget is the only part members see. It is a small HTML/CSS/JS snippet that you paste into a Ghost page. When a signed-in member clicks the button, it asks Ghost for the member's signed entitlement token, sends it to the Worker's `/code` endpoint, and shows the linking code with a copy button and a 10-minute countdown.

**In this step:** 5.1 choose how the widget reaches the Worker → 5.2 copy the widget code → 5.3 create the page in Ghost and paste the widget → 5.4 publish it and add it to your menu.

## 5.1 Choose how the widget reaches the Worker

=== "A · Through nginx (recommended)"

    The browser calls `https://<your-site>/code`, and nginx forwards the request to the Worker. The call stays on your domain (no CORS) and the Worker hostname stays out of sight.

    1. Add this block inside the `server { }` block that serves your Ghost site, replacing `<worker-subdomain>` (for example `ghost-discord-worker.myaccount`):

        ```nginx
        --8<-- "nginx-code.conf"
        ```

    2. Validate and reload nginx:

        ```sh
        sudo nginx -t && sudo systemctl reload nginx
        ```

    3. Check that the route answers: `curl -s -X POST https://<your-site>/code -d '{}'` must return `{"error":"Missing token"}`.

    With this option you keep `CODE_URL = "/code"` in the widget (the default).

    !!! warning "Keep the `resolver` lines"
        Without them nginx resolves `workers.dev` once at startup; when Cloudflare changes its IPs, `/code` starts failing with `502` after a few hours.

=== "B · Direct to the Worker"

    No server change: the browser calls the Worker URL directly, allowed by the CORS headers the Worker sends for `GHOST_URL`.

    You will change one line in the widget at step 5.2:

    ```js
    const CODE_URL = "https://ghost-discord-worker.<account>.workers.dev/code";
    ```

    `GHOST_URL` must match your site origin exactly (scheme, `www`, no trailing slash), otherwise the browser blocks the call.

## 5.2 Copy the widget code

1. Click the copy button at the top right of the block below.
2. **Option B only:** in the copied code, replace `const CODE_URL = "/code";` with your Worker URL (see 5.1).
3. Optional: adjust the colours in the `<style>` block to match your theme.

```html
--8<-- "discord-widget.html"
```

The widget displays values with `textContent` only (no HTML injection) and loads no external script.

## 5.3 Create the page in Ghost and paste the widget

1. In **Ghost Admin**, open **Pages** and click **New page**.
2. Give it a title, for example *Discord access*, and a short intro such as *"Link your Discord account to get your member roles."*
3. On an empty line, click **+** (or type `/`) and choose the **HTML** card.
4. Paste the widget code into the card, then click outside the card to close it.
5. Open the page settings (gear icon, top right):
    - **Page URL**: `discord`, so the page lives at `https://<your-site>/discord/`;
    - **Page access**: **Members only**. Visitors who are not signed in see Ghost's sign-up call to action instead of the widget.

!!! info "The editor shows the code, not the button"
    The Ghost editor displays the HTML card as code. Use **Preview** (top right) to see the rendered widget before publishing.

## 5.4 Publish the page and add it to your menu

1. Click **Publish**, then confirm.
2. Optional: in **Settings → Navigation**, add an item *Discord* pointing to `/discord/`.

## Check before moving on

- [ ] **Signed out**, `https://<your-site>/discord/` shows Ghost's sign-up prompt.
- [ ] **Signed in** as a member, clicking **Get my Discord code** shows an 8-character code and a countdown.
- [ ] Clicking again returns the **same** code: the Worker keeps one live code per member.

If clicking shows an error, see the troubleshooting table at [step 6](6-test.md#troubleshooting).

[Next: Test & go live :material-arrow-right:](6-test.md){ .md-button .md-button--primary }
