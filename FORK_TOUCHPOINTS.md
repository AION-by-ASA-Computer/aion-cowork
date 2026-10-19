# Fork touchpoints: AION Cowork su Open Cowork

## Scopo

Questo documento tiene il fork `aion-cowork` facile da riallineare con il repository upstream `OpenCoworkAI/open-cowork` (remote `upstream`, branch `main`).

Ogni file upstream che modifichiamo aumenta il costo di ogni merge: un conflitto su un file toccato in più punti richiede lavoro manuale. Per questo teniamo il codice nostro isolato e dichiariamo ogni modifica residua.

## Regole

1. **Il nuovo codice vive in cartelle nuove.** Ad esempio:
   - `src/main/enterprise/` per la logica lato main process (Enterprise);
   - `src/renderer/theme/` per il tema AION;
   - i file overlay elencati nello script `scripts/check-fork-touchpoints.mjs` (ad esempio `src/renderer/components/EnterpriseOnboarding.tsx`, `src/shared/enterprise-types.ts`, `src/renderer/utils/enterprise-api.ts`).
2. **I file upstream ricevono solo piccoli hook-in.** Un hook-in è una modifica minima (import, chiamata, prop, una stringa) che rimanda al codice nostro. Niente logica di business dentro i file upstream.
3. **Ogni file upstream modificato va elencato nella tabella qui sotto**, con il motivo. Un file non dichiarato fa fallire `npm run check:fork`.
4. **Soglia di allerta:** se i file sorgente upstream modificati superano circa 15, oppure se stimiamo un merge che costa più di 1 giorno, bisogna rivedere l'approccio (spostare la modifica in un overlay, o ridurre il perimetro).
5. Gli asset binari (`resources/**`, `public/*.png`, `src/renderer/assets/**`) non sono inclusi nella tabella e non vengono controllati.

## Verifica e sincronizzazione

- `npm run check:fork`: confronta i file modificati rispetto al merge-base con `upstream/main` con la tabella e stampa il conteggio rispetto alla soglia di 15.
- `scripts/sync-upstream.sh`: esegue il fetch di upstream, crea il branch `sync/upstream-AAAA-MM-GG`, stampa il report di rischio conflitti e avvia il merge senza commit. Con `--dry-run` stampa solo il report.

## Stato attuale

Alla data di redazione risultano **oltre 40 file sorgente upstream modificati** (`npm run check:fork` stampa il conteggio aggiornato), quindi sopra la soglia di allerta di 15. Il conteggio è da ridurre nel tempo, spostando la logica negli overlay.

## File upstream modificati

| File upstream modificato | Motivo |
|---|---|
| `electron-builder.yml` | Branding AION: nome prodotto, copyright, descrizioni dei permessi macOS; rimosso l'owner di release upstream |
| `index.html` | Titolo della pagina impostato su "AION Cowork" |
| `scripts/compress-dmg.js` | Nome prodotto di fallback "AION Cowork" per il DMG |
| `src/main/agent/agent-runner-message-end.ts` | Messaggi di errore dell'agente in inglese e con marchio AION |
| `src/main/agent/agent-runner.ts` | System prompt "AION Cowork assistant" e messaggi di timeout in inglese |
| `src/main/config/config-store.ts` | Nome predefinito del set di configurazione "Default" invece del cinese |
| `src/main/index.ts` | Branding (tray, log, dialog); colori di sfondo AION; remote control disabilitato con `REMOTE_CONTROL_AVAILABLE = false`; nome dei log diagnostici |
| `src/main/mcp/gui-operate-server.ts` | Testi dei permessi macOS e prompt di grounding in inglese, con marchio AION |
| `src/main/mcp/mcp-config-store.ts` | Aggiunto il preset MCP `aion-ocr` (bridge GLM-OCR su PGX) |
| `src/main/mcp/mcp-manager.ts` | Messaggi di errore per Node, npx e Chrome in sola lingua inglese, con marchio AION |
| `src/main/mcp/mcp-oauth.ts` | `client_name` e pagine HTML di autorizzazione con marchio AION |
| `src/main/memory/memory-prompts.ts` | Prompt della memoria in inglese, chiavi in snake_case inglese |
| `src/main/session/session-title-utils.ts` | Prompt di generazione del titolo in inglese, massimo 6 parole |
| `src/main/tools/sandbox-tool-executor.ts` | Messaggio di timeout in inglese |
| `src/main/tools/tool-executor.ts` | Messaggio di timeout in inglese |
| `src/main/utils/logger.ts` | Intestazione del log "AION Cowork Application Log" |
| `src/renderer/components/ChatView.tsx` | Nome "AION Cowork" nell'header della chat |
| `src/renderer/components/RemoteControlPanel.tsx` | Rimossa la dipendenza da i18n per il separatore cinese dei permessi (pannello nascosto) |
| `src/renderer/components/SettingsPanel.tsx` | Rimossa la scheda "Remote control" dalle impostazioni |
| `src/renderer/components/Sidebar.tsx` | Nome "AION Cowork" nella sidebar |
| `src/renderer/components/WelcomeView.tsx` | Nome "AION Cowork" nella schermata di benvenuto |
| `src/renderer/components/settings/SettingsGeneral.tsx` | Selettore lingua con Italiano e English al posto di 中文; versione mostrata come "AION Cowork" |
| `src/renderer/components/settings/SettingsMemory.tsx` | Testi della sezione memoria tradotti in inglese |
| `src/renderer/hooks/useIPC.ts` | `startSession` accetta `profileId` opzionale e lo inoltra nel payload di `session.start` (profilo enterprise) |
| `src/renderer/hooks/useApiConfigState.ts` | Nome predefinito "Default" e migrazione del vecchio nome cinese del set |
| `src/renderer/i18n/config.ts` | Risorsa `zh` sostituita con `it`; fallback inglese |
| `src/renderer/i18n/locales/en.json` | Testi di branding AION e aggiornamenti di copy (ad esempio provider email e remote channel) |
| `src/renderer/i18n/locales/it.json` | File nuovo: traduzione italiana dell'interfaccia |
| `src/renderer/styles/globals.css` | Font Inter al posto di Plus Jakarta Sans; palette del tema scuro neutra AION |
| `src/renderer/utils/i18n-format.ts` | Locale `it-IT` per date e numeri; separatore delle liste ", " |
| `src/shared/api-model-presets.ts` | Hint delle chiavi API in inglese e preset adattati al contesto AION |
| `src/shared/schedule/task-title.ts` | Prefisso "[Scheduled Task]" in inglese; riconosce ancora il vecchio prefisso per non duplicarlo |
| `tailwind.config.js` | Font sans impostato su Inter |
| `tests/agent-runner-message-end.test.ts` | Aggiornamento alle nuove stringhe di errore |
| `tests/chat-view-claude-layout.test.ts` | Aggiornamento al nuovo nome "AION Cowork" |
| `tests/dark-theme-palette.test.ts` | Aggiornamento alla palette AION |
| `tests/schedule-task-title.test.ts` | Aggiornamento al nuovo prefisso dei task pianificati |
| `tests/session-manager-scheduled-title.test.ts` | Aggiornamento al nuovo prefisso dei task pianificati |
| `tests/session-title-utils.test.ts` | Aggiornamento al nuovo prompt del titolo |
| `tests/theme-settings-persistence.test.ts` | Aggiornamento ai colori di sfondo AION |
| `tests/welcome-view-claude-layout.test.ts` | Aggiornamento al nuovo nome "AION Cowork" |

## Hook-in Enterprise

Il codice enterprise vive negli overlay (`src/main/enterprise/`, `src/shared/enterprise-types.ts`, `src/renderer/components/EnterpriseOnboarding.tsx`, `src/renderer/components/settings/SettingsAccount.tsx`, `src/renderer/hooks/useEnterpriseStatus.ts`, `src/renderer/utils/enterprise-*.ts`). I file upstream sotto hanno solo piccoli hook-in:

| File upstream | Hook-in |
|---|---|
| `src/main/index.ts` | `registerEnterpriseIpc(...)`, avvio scheduler, redazione di `config.get`/payload con `getAllRedacted()`/`redactManagedSecrets()`, canale `enterprise-status` |
| `src/preload/index.ts` | namespace `enterprise` (canali IPC e `onStatus`) |
| `src/main/config/config-store.ts` | set gestito `managed: 'aion'`: `applyManagedAionSet`, `removeManagedAionSet`, guardie, redazione, export/import |
| `src/main/config/agent-runtime-signature.ts`, `src/main/agent/agent-runner.ts`, `src/main/agent/pi-session-runtime.ts` | il token del set gestito non fa ricreare la sessione pi (`excludeApiKey`) |
| `src/renderer/App.tsx` | wizard di onboarding (lazy) quando `onboardingRequired` |
| `src/renderer/components/SettingsPanel.tsx`, `src/main/nav-server.ts` | tab `account` |
| `src/renderer/i18n/locales/en.json`, `src/renderer/i18n/locales/it.json`, `src/renderer/i18n/locales/zh.json` | chiavi `enterprise.*` e `settings.account*` |
| `package.json` | script `check:fork` |

Candidati a contributo a monte: set di configurazione gestiti/bloccati, header custom per modello, filtro MCP per sessione.
