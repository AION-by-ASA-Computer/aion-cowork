# Contratto API client Enterprise (aion-cowork ↔ AION Agent)

Versione contratto: `api_version = 1`. Questo file è la fonte unica per server (`AION_Agent`, branch `enterprise-client-api`) e client (`aion-cowork`, branch `enterprise-mode`). Se un'implementazione deve scostarsi, aggiornare prima questo file.

## Base URL
L'utente inserisce l'endpoint aziendale, ad esempio `https://agent.azienda.it/api` (Caddy) oppure `http://host:8001` (backend diretto). Il client elimina gli spazi e gli `/` finali e **aggiunge i percorsi sotto** a questa base. Non aggiunge né rimuove `/api`.

## Percorsi esistenti usati dal client (invariati)
- `GET /health` → `{status:"ok", service:"aion-api"}` (pubblico).
- `GET /auth/status` (pubblico) → `password_auth_enabled`, `login_mode`, `sso_enabled`, `two_factor_required`, `token_ttl_seconds`, ...
- `POST /auth/login` `{username, password, client:"chat"}` → payload di login (vedi sotto) **oppure** sfida 2FA.
- `POST /auth/2fa/verify` `{mfa_token, code}` → payload di login.
- `POST /auth/2fa/enroll/start` `{mfa_token}` → `{otpauth_uri, qr_svg, secret}`; `POST /auth/2fa/enroll/confirm` `{mfa_token, code}` → payload di login.
- `GET /auth/me` (Bearer) e `POST /auth/change-password` `{old_password, new_password}` (Bearer).
- Errori: 401 `"Invalid credentials"`; 403 `{detail:{code:"password_login_disabled"|"sso_required"}}`; 401 `{detail:{code:"temp_password_expired"}}`; 429 `{detail:{code:"mfa_locked", retry_after}}`.

## Payload di login (esteso)
```json
{
  "access_token": "…", "token_type": "bearer",
  "user_id": "…", "identifier": "…", "display_name": "…",
  "roles": ["user"], "must_change_password": false, "sso_link_required": false,
  "expires_at": "2026-10-26T10:00:00Z",   // NUOVO, ISO 8601 UTC
  "expires_in": 604800                     // NUOVO, secondi
}
```
Gli stessi due campi nuovi compaiono su `/auth/2fa/verify`, `/auth/2fa/enroll/confirm`, `/auth/sso/exchange` e `/auth/refresh`.

## Nuovi percorsi (da implementare lato server)

### `GET /v1/client/info` (pubblico, senza token)
```json
{
  "product": "aion-agent", "api_version": 1, "version": "1.6.2",
  "min_client_version": "1.0.0",
  "login_mode": "password", "password_auth_enabled": true,
  "sso_enabled": false, "two_factor_required": false,
  "token_ttl_seconds": 604800,
  "login_url": "https://agent.azienda.it/login",   // NUOVO: pagina di login web (chat-ui), da chat_base_url()
  "features": {"llm_proxy": true, "client_bootstrap": false, "desktop_login": true}
}
```
`features.client_bootstrap` diventa `true` con la Fase 2. Il client usa questo percorso per validare l'endpoint (se risponde con `product == "aion-agent"` e `api_version` supportata); se fallisce, ripiega su `/health` + `/auth/status` e segnala una versione server non verificabile.

### `POST /auth/refresh` (Bearer valido, non scaduto)
Corpo vuoto. Risposta: payload di login con **nuovo** `access_token` e `expires_at`. 401 se il token è scaduto o non valido (il client torna al login). Il token resta stateless (stesso formato HMAC esistente).

### `POST /auth/logout` (Bearer)
Risposta `{ "ok": true }`. Il token è stateless: non c'è revoca lato server, il client elimina il token locale. Il server può registrare l'evento in audit.

### `GET /v1/llm/models` (Bearer)
Elenca i provider LLM abilitati (`llm_providers.enabled`), solo campi non segreti:
```json
{ "object": "list", "data": [
  { "id": "<slug>", "object": "model", "owned_by": "aion",
    "name": "<display_name>", "model_name": "<model_name>",
    "description": "…", "is_default": true } ] }
```
`id` è lo `slug` del provider (è ciò che il client passa come `model`).

### `POST /v1/llm/chat/completions` (Bearer)
Proxy OpenAI-compatibile **senza agente**: inoltra la richiesta al provider selezionato da `model` (= slug), sostituendo il modello con `model_name` del provider e usando `api_base_url` + chiave decifrata **solo lato server**. Requisiti:
- Supporta `stream: true` (SSE passthrough, righe `data: …` e `data: [DONE]`) e non-stream.
- Inoltra `messages`, `tools`, `tool_choice`, `temperature`, `max_tokens`, `top_p`, `stop`, `response_format`, `reasoning_effort` se presenti; il resto viene ignorato.
- Applica `max_chat_tokens` del provider come tetto a `max_tokens`.
- Slug sconosciuto o disabilitato → 404 `{error:{message, type:"invalid_request_error", code:"model_not_found"}}`. Errori del provider tradotti in forma OpenAI (`{error:{message,type,code}}`) con lo stesso status quando sensato (429, 400, 401 → 502).
- Mai restituire chiavi, `api_base_url` interno o header del provider.
- Autenticazione: stessa dipendenza degli endpoint `/v1/*` (`require_chat_auth`); tenant dall'utente.

### Fix di sicurezza
`GET /v1/integrations/credentials/{server_slug}/{key}` non deve più restituire valori `org_shared`/`default` agli utenti normali: ammesso solo per credenziali `per_user` dell'utente corrente (altrimenti 403/404). Non esistono più percorsi che espongano segreti in chiaro a un utente non admin.

## Convenzioni client
- Il client invia `Authorization: Bearer <access_token>`.
- Rinnovo: quando mancano meno di 24 h (o 10% del TTL) alla scadenza chiama `/auth/refresh`; su 401 passa a "sessione scaduta" e chiede il login.
- Il set di configurazione gestito "AION" usa `provider: custom`, `customProtocol: openai`, `baseUrl = <endpoint>/v1/llm`, `apiKey = access_token`, `model = <slug scelto>`.

## Login desktop via browser (PKCE + loopback), unico punto di login
Il client non raccoglie password: apre la pagina di login web del server (che gestisce password, SSO Microsoft/Google, 2FA, ecc.) nel browser di sistema e riceve un codice monouso su un callback loopback.

1. Il client genera `code_verifier` (43-128 caratteri base64url casuali), `code_challenge = base64url(sha256(code_verifier))`, `state` (casuale), apre un server HTTP su `127.0.0.1:<porta libera>` e apre nel browser:
   `<login_url>?desktop=1&state=<state>&challenge=<code_challenge>&redirect=http%3A%2F%2F127.0.0.1%3A<porta>%2Fcallback`
   (`login_url` da `/v1/client/info`; in mancanza, l'endpoint senza il suffisso `/api` + `/login`).
2. La pagina web fa login con qualunque metodo. A login completato, se i parametri `desktop` sono presenti, chiama `POST /auth/desktop/handoff` (Bearer del token appena ottenuto) con `{challenge, state, redirect}` e riceve `{code, expires_in}`; poi naviga a `<redirect>?code=<code>&state=<state>`.
3. Il client verifica `state`, risponde con una pagina HTML "Accesso completato, puoi tornare ad AION Cowork" e chiama `POST /auth/desktop/exchange` con `{code, code_verifier}` (senza Bearer).

### `POST /auth/desktop/handoff` (Bearer token chat, non API key)
Corpo `{challenge, state, redirect}`. Valida `redirect` con la allow-list (env `AION_DESKTOP_REDIRECT_ALLOWLIST`, separata da virgole; di default sono ammessi solo URL loopback `http://127.0.0.1:<qualsiasi porta>/callback`, `http://localhost:<porta>/callback` e `http://[::1]:<porta>/callback`). Salva (cifrato) `{user, challenge, state, redirect}` in `sso_auth_states` con `kind="desktop_handoff"`, TTL 60 s, monouso. Risposta `{code, expires_in}`. Errori: 400 `{detail:{code:"redirect_not_allowed"|"invalid_challenge"}}`, 401.

### `POST /auth/desktop/exchange` (pubblico)
Corpo `{code, code_verifier}`. Verifica `base64url(sha256(code_verifier)) == challenge` (confronto a tempo costante) e consuma il codice in modo atomico (un verifier errato brucia il codice). Emette un **nuovo** token per l'utente e risponde con il payload di login standard (con `expires_at`/`expires_in`, `must_change_password`, `sso_link_required`). Errori: 400 `{detail:{code:"invalid_code"|"code_expired"|"code_already_used"|"invalid_verifier"}}`.
