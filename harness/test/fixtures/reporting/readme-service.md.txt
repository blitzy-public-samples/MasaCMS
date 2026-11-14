# identity service

Source SHA: 696383140578f8dea3ece26f80cd7bfb370ddf0f

## What it does

Signs administrators in and out, and manages user groups, who belongs to them and the permissions they grant on content and admin modules.

## Masa features replaced

The admin circuits `clogin`, `cperm` and `cwebservice`, and the group actions of `cusers`.

## Owned tables

`tusersmemb`, `tpermissions` and `toauthclients`, held in schema `identity` as `identity.membership`, `identity.permission` and `identity.oauth_client`.

## Routes

- `admin:clogin.login`: admin login, reached through the gateway.
- `POST /internal/v1/tokens`: mints the site-scoped user token of a session.

## Events

- Produced: `identity.group.changed.v1`.
- Consumed: `programs-sites.site.changed.v1`, which fills `identity.tenant_registry`.

## How to run

```sh
npm ci
npm test
PORT=8111 npm start
```
