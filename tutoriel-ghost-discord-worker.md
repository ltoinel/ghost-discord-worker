# Configurer ghost-discord-worker : attribuer des rôles Discord aux membres de votre blog Ghost

Ce tutoriel vous guide pas à pas dans l'installation de [ghost-discord-worker](https://github.com/ltoinel/ghost-discord-worker), un Cloudflare Worker qui synchronise les membres de votre blog Ghost avec des rôles sur votre serveur Discord. Une fois la configuration terminée, un lecteur inscrit sur votre blog obtient automatiquement le rôle **Member** sur Discord, et un abonné payant reçoit en plus le rôle **Premium Member**.

Comptez environ 45 minutes pour une première installation.

## Comment cela fonctionne

Le Worker fait le lien entre trois acteurs :

1. **Ghost** prévient le Worker, via des webhooks, lorsqu'un membre est créé, modifié ou supprimé.
2. **Le lecteur** prouve qu'il possède bien son compte Ghost : connecté sur votre blog, il clique sur un bouton qui génère un code à usage unique valable 10 minutes.
3. **Discord** reçoit la commande `/link <code>` tapée par le lecteur, la transmet au Worker, qui associe l'adresse e-mail Ghost au compte Discord et attribue les rôles.

La correspondance e-mail ↔ identifiant Discord est stockée dans un espace Cloudflare KV. Chaque e-mail ne peut être lié qu'à un seul compte Discord, et inversement.

## Prérequis

- Node.js 20 ou supérieur et Git installés sur votre poste.
- Un compte [Cloudflare](https://dash.cloudflare.com/sign-up) (l'offre gratuite suffit).
- Un serveur Discord dont vous êtes administrateur.
- Un blog Ghost 5.x dont vous êtes administrateur.
- (Recommandé) Un accès à la configuration nginx qui sert votre blog Ghost.

## Les valeurs à remplacer

Tout au long du tutoriel, les éléments entre chevrons sont à remplacer par vos propres valeurs. Notez-les au fur et à mesure dans un fichier temporaire, vous en aurez besoin à l'étape 6.

| Valeur | Description | Exemple | Obtenue à l'étape |
|---|---|---|---|
| `<APPLICATION_ID>` | Identifiant de l'application Discord | `1412189819643236422` | 2 |
| `<DISCORD_PUBLIC_KEY>` | Clé publique de l'application (64 caractères hexadécimaux) | `23e755d2…bce9f` | 2 |
| `<DISCORD_BOT_TOKEN>` | Token secret du bot | `MTQxMjE4…` | 2 |
| `<DISCORD_GUILD_ID>` | Identifiant de votre serveur Discord | `987654321098765432` | 3 |
| `<DISCORD_ROLE_MEMBER>` | Identifiant du rôle « Member » | `111111111111111111` | 3 |
| `<DISCORD_ROLE_PREMIUM>` | Identifiant du rôle « Premium Member » | `222222222222222222` | 3 |
| `<GHOST_URL>` | URL de votre blog, **sans slash final** | `https://www.geeek.org` | 4 |
| `<GHOST_ADMIN_API_KEY>` | Clé Admin API de Ghost, format `id:secret` | `6523ab…:9f8e7d…` | 4 |
| `<WEBHOOK_SECRET>` | Secret partagé entre Ghost et le Worker | chaîne aléatoire | 5 |
| `<ADMIN_SECRET>` | Jeton protégeant les endpoints d'administration | chaîne aléatoire | 5 |
| `<KV_NAMESPACE_ID>` | Identifiant de l'espace KV Cloudflare | `a1b2c3d4…` | 6 |
| `<WORKER_URL>` | URL publique de votre Worker | `https://ghost-discord-worker.moncompte.workers.dev` | 7 |

> Le token du bot, la clé Admin API Ghost, `WEBHOOK_SECRET` et `ADMIN_SECRET` sont des secrets. Ne les committez jamais dans un dépôt Git et ne les partagez pas.

## Étape 1 : récupérer le projet

```sh
git clone https://github.com/ltoinel/ghost-discord-worker.git
cd ghost-discord-worker
npm install
cp wrangler.toml.sample wrangler.toml
```

Connectez ensuite Wrangler (l'outil en ligne de commande de Cloudflare) à votre compte :

```sh
npx wrangler login
```

Une page s'ouvre dans votre navigateur pour autoriser l'accès.

## Étape 2 : créer l'application Discord

### 2.1 Créer l'application

1. Rendez-vous sur le [portail développeur Discord](https://discord.com/developers/applications).
2. Cliquez sur **Nouvelle application** (en haut à droite), donnez-lui un nom (par exemple le nom de votre blog), acceptez les conditions et validez.

### 2.2 Relever l'identifiant et la clé publique

Dans le menu de gauche, ouvrez **Informations générales** :

- Copiez l'**Identifiant d'application** : c'est votre `<APPLICATION_ID>`.
- Copiez la **Clé publique** : c'est votre `<DISCORD_PUBLIC_KEY>`.

Vous pouvez aussi renseigner ici une icône et une description, qui apparaîtront sur le profil du bot. Laissez pour l'instant le champ **URL du point de terminaison des interactions** vide : vous le remplirez à l'étape 8, une fois le Worker déployé.

### 2.3 Générer le token du bot

1. Ouvrez l'onglet **Bot**.
2. Cliquez sur **Réinitialiser le token**, confirmez, puis copiez la valeur affichée : c'est votre `<DISCORD_BOT_TOKEN>`. Discord ne l'affichera plus jamais, conservez-le précieusement.
3. Sur la même page, aucun **Privileged Gateway Intent** n'est nécessaire : le Worker reçoit les commandes par HTTP et n'utilise pas la Gateway. Laissez-les tous désactivés.

### 2.4 Définir les droits d'installation

Ouvrez l'onglet **Installation** :

1. Dans **Contextes d'installation**, cochez **Installation pour une guilde**. L'option **Installation pour un utilisateur** n'est pas utile, les rôles n'existant que sur votre serveur : vous pouvez la décocher.
2. Dans **Paramètres d'installation par défaut** → **Installation pour une guilde** :
   - **Champs d'application** : `applications.commands` et `bot`.
   - **Permissions** : uniquement **Gérer les rôles**. N'ajoutez rien d'autre, le Worker n'en a pas besoin.
3. Enregistrez les modifications.

### 2.5 Inviter le bot sur votre serveur

Toujours dans **Installation**, copiez le **Lien d'installation** fourni par Discord :

```
https://discord.com/oauth2/authorize?client_id=<APPLICATION_ID>
```

Ouvrez-le dans votre navigateur, choisissez **Ajouter à un serveur**, sélectionnez votre serveur et validez.

### 2.6 (Optionnel) Rendre le bot privé

Une fois le bot installé, vous pouvez empêcher d'autres personnes de l'ajouter à leur serveur. Dans **Installation**, passez le lien d'installation à **Aucun**, puis dans l'onglet **Bot**, désactivez **Bot public**[^1].

## Étape 3 : préparer le serveur Discord

### 3.1 Activer le mode développeur

Le mode développeur affiche l'option « Copier l'identifiant » dans les menus contextuels de Discord.

Dans Discord : **Paramètres utilisateur** (roue dentée en bas à gauche) → **Avancés** → activez **Mode développeur**.

### 3.2 Récupérer l'identifiant du serveur

Faites un clic droit sur l'icône de votre serveur dans la colonne de gauche → **Copier l'identifiant du serveur**. C'est votre `<DISCORD_GUILD_ID>`.

### 3.3 Créer les deux rôles

1. **Paramètres du serveur** → **Rôles** → **Créer un rôle**.
2. Créez un rôle nommé **Member**, puis un second nommé **Premium Member**. Personnalisez couleurs et permissions comme vous le souhaitez (accès à un salon réservé, par exemple).
3. Pour chaque rôle, faites un clic droit dessus dans la liste → **Copier l'identifiant du rôle** :
   - celui de **Member** est votre `<DISCORD_ROLE_MEMBER>` ;
   - celui de **Premium Member** est votre `<DISCORD_ROLE_PREMIUM>`.

### 3.4 Placer le rôle du bot au-dessus

C'est l'oubli le plus fréquent. Discord interdit à un bot de gérer un rôle situé au-dessus du sien dans la hiérarchie.

Dans **Paramètres du serveur** → **Rôles**, faites glisser le rôle portant le nom de votre bot **au-dessus** de « Member » et « Premium Member ». Sans cela, l'attribution des rôles échouera avec une erreur `403`.

## Étape 4 : configurer Ghost (clé Admin API)

1. Dans l'administration Ghost : **Settings** → **Integrations** → **Add custom integration**.
2. Nommez-la par exemple « Discord » et validez.
3. Copiez l'**Admin API key** (format `id:secret`) : c'est votre `<GHOST_ADMIN_API_KEY>`.

Gardez cette page ouverte : vous y ajouterez les webhooks à l'étape 9.

Notez aussi l'URL exacte de votre blog, schéma compris et **sans slash final** (par exemple `https://www.geeek.org`) : c'est votre `<GHOST_URL>`. Elle doit correspondre exactement à l'origine vue par le navigateur, car le Worker l'utilise pour vérifier les jetons des membres et pour les en-têtes CORS.

## Étape 5 : générer les secrets partagés

Générez deux chaînes aléatoires robustes :

```sh
openssl rand -hex 32   # → <WEBHOOK_SECRET>
openssl rand -hex 32   # → <ADMIN_SECRET>
```

- `<WEBHOOK_SECRET>` permet au Worker de vérifier la signature HMAC des webhooks envoyés par Ghost.
- `<ADMIN_SECRET>` protège les endpoints d'administration `/link` (création, consultation et suppression manuelles de liaisons).

## Étape 6 : configurer le Worker

### 6.1 Créer l'espace KV

```sh
npx wrangler kv namespace create GHOST_DISCORD_MAPPING
```

La commande affiche un bloc contenant un `id` : c'est votre `<KV_NAMESPACE_ID>`.

### 6.2 Compléter `wrangler.toml`

Ouvrez `wrangler.toml` et remplacez la valeur de `id` :

```toml
name = "ghost-discord-worker"
main = "src/index.ts"
compatibility_date = "2024-12-02"

[[kv_namespaces]]
binding = "GHOST_DISCORD_MAPPING"
id = "<KV_NAMESPACE_ID>"
```

Ne modifiez pas `compatibility_date` : cette date est nécessaire pour la vérification des signatures Ed25519 de Discord.

### 6.3 Enregistrer les secrets

Chaque commande vous demande de coller la valeur correspondante. Attention aux espaces en début ou fin de valeur lors du copier-coller.

```sh
npx wrangler secret put WEBHOOK_SECRET        # <WEBHOOK_SECRET>
npx wrangler secret put ADMIN_SECRET          # <ADMIN_SECRET>
npx wrangler secret put DISCORD_BOT_TOKEN     # <DISCORD_BOT_TOKEN>
npx wrangler secret put DISCORD_GUILD_ID      # <DISCORD_GUILD_ID>
npx wrangler secret put DISCORD_PUBLIC_KEY    # <DISCORD_PUBLIC_KEY>
npx wrangler secret put DISCORD_ROLE_MEMBER   # <DISCORD_ROLE_MEMBER>
npx wrangler secret put DISCORD_ROLE_PREMIUM  # <DISCORD_ROLE_PREMIUM>
npx wrangler secret put GHOST_URL             # <GHOST_URL>
npx wrangler secret put GHOST_ADMIN_API_KEY   # <GHOST_ADMIN_API_KEY>
```

Si la commande vous propose de créer le Worker parce qu'il n'existe pas encore, acceptez.

## Étape 7 : déployer le Worker

```sh
npm run deploy
```

En fin de déploiement, Wrangler affiche l'URL publique du Worker, de la forme :

```
https://ghost-discord-worker.<VOTRE_SOUS_DOMAINE>.workers.dev
```

C'est votre `<WORKER_URL>`. Le Worker expose les routes suivantes :

| Route | Appelée par | Rôle |
|---|---|---|
| `POST <WORKER_URL>/discord` | Discord | Commandes `/link` et `/unlink` |
| `POST <WORKER_URL>/webhook/added` | Ghost | Membre créé |
| `POST <WORKER_URL>/webhook/updated` | Ghost | Membre modifié (gratuit ↔ payant) |
| `POST <WORKER_URL>/webhook/deleted` | Ghost | Membre supprimé |
| `POST <WORKER_URL>/code` | Navigateur du lecteur | Génération du code de liaison |
| `/link` (POST, GET, DELETE) | Vous (administration) | Gestion manuelle des liaisons |

## Étape 8 : brancher Discord sur le Worker

### 8.1 Renseigner l'URL des interactions

1. Retournez sur le portail développeur Discord → votre application → **Informations générales**.
2. Dans **URL du point de terminaison des interactions**, saisissez :

   ```
   <WORKER_URL>/discord
   ```

   Vérifiez qu'aucun espace ne s'est glissé avant ou après l'URL.
3. Cliquez sur **Enregistrer les modifications**.

Discord envoie alors une requête de test signée au Worker. Si l'enregistrement est accepté, la vérification de signature fonctionne. S'il est refusé, vérifiez que le secret `DISCORD_PUBLIC_KEY` correspond exactement à la clé publique affichée sur cette page.

### 8.2 Enregistrer les commandes slash

Le Worker ne déclare pas lui-même les commandes `/link` et `/unlink` : vous devez les enregistrer une fois auprès de l'API Discord. L'enregistrement au niveau du serveur (guild) est pris en compte immédiatement.

```sh
curl -X PUT \
  "https://discord.com/api/v10/applications/<APPLICATION_ID>/guilds/<DISCORD_GUILD_ID>/commands" \
  -H "Authorization: Bot <DISCORD_BOT_TOKEN>" \
  -H "Content-Type: application/json" \
  -d '[
    {
      "name": "link",
      "description": "Lier votre compte Discord à votre abonnement au blog",
      "options": [
        {
          "name": "code",
          "description": "Le code affiché sur la page Discord du blog",
          "type": 3,
          "required": true
        }
      ]
    },
    {
      "name": "unlink",
      "description": "Délier votre compte Discord de votre abonnement au blog"
    }
  ]'
```

La réponse doit être un tableau JSON contenant les deux commandes. Les descriptions sont libres ; les noms `link`, `unlink` et `code` doivent en revanche rester tels quels, le Worker s'appuie dessus.

Pour vérifier, tapez `/` dans un salon de votre serveur : les commandes de votre bot apparaissent.

## Étape 9 : déclarer les webhooks dans Ghost

Retournez dans **Settings** → **Integrations** → l'intégration « Discord » créée à l'étape 4, puis cliquez sur **Add webhook** trois fois :

| Name | Event | Target URL | Secret |
|---|---|---|---|
| Discord - ajout | Member added | `<WORKER_URL>/webhook/added` | `<WEBHOOK_SECRET>` |
| Discord - modification | Member updated | `<WORKER_URL>/webhook/updated` | `<WEBHOOK_SECRET>` |
| Discord - suppression | Member deleted | `<WORKER_URL>/webhook/deleted` | `<WEBHOOK_SECRET>` |

Le champ **Secret** est indispensable : Ghost s'en sert pour signer chaque requête (en-tête `X-Ghost-Signature`), et le Worker rejette toute requête non signée.

Correspondance entre événements Ghost et actions Discord :

| Événement Ghost | Action sur Discord |
|---|---|
| Membre ajouté (gratuit) | Ajout du rôle Member |
| Membre ajouté (payant ou offert) | Ajout des rôles Member et Premium Member |
| Passage gratuit → payant | Ajout du rôle Premium Member |
| Passage payant → gratuit | Retrait du rôle Premium Member |
| Membre supprimé | Retrait des deux rôles |

Ces webhooks n'ont d'effet que pour les membres ayant déjà lié leur compte. Pour les autres, le Worker répond `200 OK` sans rien faire, ce qui évite que Ghost ne relance la requête.

## Étape 10 : publier la page « Accès Discord » sur votre blog

Vos lecteurs ont besoin d'une page où générer leur code.

### 10.1 (Recommandé) Proxifier `/code` via nginx

Si votre blog est servi par nginx, ajoutez ce bloc dans le `server { }` de votre site. Le navigateur appellera alors `<GHOST_URL>/code` : l'appel devient « same-origin » (pas de requête CORS préalable) et l'URL du Worker n'apparaît pas côté lecteur.

```nginx
location = /code {
    # Résolution DNS dynamique : les IP de workers.dev changent
    resolver 1.1.1.1 8.8.8.8 valid=60s ipv6=off;

    set $worker_upstream "ghost-discord-worker.<VOTRE_SOUS_DOMAINE>.workers.dev";
    proxy_pass https://$worker_upstream$request_uri;

    proxy_set_header Host $worker_upstream;
    proxy_ssl_server_name on;
    proxy_ssl_name        $worker_upstream;
    proxy_ssl_verify      on;

    proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_set_header X-Real-IP         $remote_addr;

    proxy_connect_timeout 5s;
    proxy_send_timeout    10s;
    proxy_read_timeout    10s;

    proxy_http_version 1.1;
    proxy_buffering    off;
}
```

Remplacez `<VOTRE_SOUS_DOMAINE>` par celui de votre `<WORKER_URL>`, puis validez et rechargez :

```sh
sudo nginx -t && sudo systemctl reload nginx
```

Le couple `resolver` + variable dans `proxy_pass` n'est pas optionnel : sans lui, nginx résout le nom une seule fois au démarrage et finit par renvoyer des erreurs `502 "no live upstreams"` lorsque Cloudflare change d'adresse IP.

### 10.2 Créer la page dans Ghost

1. Dans Ghost : **Pages** → **New page**, titrée par exemple « Accès Discord » (URL `/discord/`).
2. Ajoutez une **carte HTML** (tapez `/html` dans l'éditeur).
3. Collez-y le snippet HTML + CSS + JS fourni dans [`spec/08-configuration.md`](https://github.com/ltoinel/ghost-discord-worker/blob/main/spec/08-configuration.md#get-my-discord-code-page-theme-js).
4. Repérez la ligne suivante dans le script :

   ```js
   const CODE_URL = "/code";
   ```

   - Avec le proxy nginx de l'étape 10.1 : laissez `"/code"`.
   - Sans proxy : remplacez par `"<WORKER_URL>/code"`.
5. Vous pouvez traduire les libellés du snippet (« Get my Discord code », « Copy »…) en français.
6. Dans les réglages de la page, passez la visibilité à **Members only** si vous souhaitez la réserver aux membres connectés.
7. Publiez, et ajoutez un lien vers cette page dans votre navigation ou vos e-mails.

## Étape 11 : tester le parcours complet

1. Connectez-vous à votre blog avec un compte membre de test.
2. Ouvrez la page `<GHOST_URL>/discord/` et cliquez sur le bouton : un code de 8 caractères s'affiche, avec un compte à rebours de 10 minutes.
3. Dans un salon de votre serveur Discord, tapez `/link` puis collez le code.
4. Le bot répond (message visible de vous seul) : *« Your email … has been linked to your Discord account. »*
5. Vérifiez que le rôle **Member** apparaît sur votre profil.
6. Dans Ghost, passez ce membre en abonnement offert (*comped*) : le rôle **Premium Member** doit apparaître quelques secondes plus tard.
7. Tapez `/unlink` pour défaire la liaison. Notez que `/unlink` ne retire pas les rôles déjà attribués : retirez-les manuellement si besoin.

Pour suivre l'activité du Worker en temps réel pendant vos tests :

```sh
npx wrangler tail
```

## Dépannage

| Symptôme | Cause probable | Solution |
|---|---|---|
| Discord refuse d'enregistrer l'URL des interactions | Clé publique erronée, Worker non déployé ou espace parasite dans l'URL | Vérifier `DISCORD_PUBLIC_KEY`, relancer `npm run deploy`, nettoyer le champ |
| Les commandes `/link` et `/unlink` n'apparaissent pas | Commandes non enregistrées ou bot installé sans `applications.commands` | Refaire l'étape 8.2, réinviter le bot avec les bons champs |
| « Invalid or expired code » | Code expiré (10 min), déjà utilisé ou mal recopié | Générer un nouveau code |
| Liaison réussie mais « roles could not be assigned » | Rôle du bot sous les rôles gérés, ou permission « Gérer les rôles » manquante | Refaire l'étape 3.4 et vérifier les permissions du bot |
| La page du blog affiche une erreur réseau | `CODE_URL` incorrect, proxy nginx absent ou `GHOST_URL` différent de l'origine réelle | Vérifier l'étape 10, et que `GHOST_URL` n'a ni slash final ni `www` en trop ou en moins |
| `502` sur `/code` après quelques heures | Proxy nginx sans `resolver` | Reprendre exactement le bloc de l'étape 10.1 |
| Les changements d'abonnement ne se répercutent pas | Webhook absent, URL erronée ou secret différent de `WEBHOOK_SECRET` | Vérifier l'étape 9 et consulter `npx wrangler tail` |

## Administration manuelle

Les endpoints `/link` permettent de gérer une liaison sans passer par le parcours lecteur, par exemple pour un ancien abonné :

```sh
# Créer une liaison
curl -X POST <WORKER_URL>/link \
  -H "Authorization: Bearer <ADMIN_SECRET>" \
  -H "Content-Type: application/json" \
  -d '{"email": "lecteur@example.com", "discord_user_id": "123456789012345678"}'

# Consulter une liaison
curl <WORKER_URL>/link/lecteur@example.com \
  -H "Authorization: Bearer <ADMIN_SECRET>"

# Supprimer une liaison
curl -X DELETE <WORKER_URL>/link \
  -H "Authorization: Bearer <ADMIN_SECRET>" \
  -H "Content-Type: application/json" \
  -d '{"email": "lecteur@example.com"}'
```

L'identifiant Discord d'un utilisateur s'obtient, en mode développeur, par un clic droit sur son pseudo → **Copier l'identifiant de l'utilisateur**.

## Récapitulatif de la configuration Discord

| Écran du portail développeur | Champ | Valeur |
|---|---|---|
| Informations générales | URL du point de terminaison des interactions | `<WORKER_URL>/discord` |
| Informations générales | URL de vérification des rôles liés | vide |
| Installation | Contextes d'installation | Installation pour une guilde |
| Installation | Champs d'application (guilde) | `applications.commands`, `bot` |
| Installation | Permissions (guilde) | Gérer les rôles |
| Bot | Privileged Gateway Intents | tous désactivés |
| Bot | Bot public | désactivé une fois le bot installé (optionnel) |

[^1]: Discord n'autorise la désactivation de l'option « Bot public » que si aucun lien d'installation par défaut n'est défini. Pour réinviter le bot plus tard, il vous faudra réactiver temporairement le lien.
