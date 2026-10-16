# Virtual Server Manager — Roadmap

> Runtime source version in this repository: **0.90.0**. Historical `vXX` labels below are development milestones.

## v89
- dodano testową serwerownię LAB-DC-01
- 16 szaf RACK z serwerami, switchami, patchpanelami
- osobne trasy LAN i światłowód
- 12 szaf compute + 2 core + 2 storage/backup

## v74
- Ulepszony live terminal w UI: pasek narzędzi, wklejanie, czyszczenie, kopiowanie, auto-resize, status połączenia.
- Stabilizacja wersji i odświeżenie paczki startowej.

# Virtual Server Manager Roadmap v71

## Zrobione
- backend monitoringu i SNMP
- bridge PostgreSQL + live sync
- role i uprawnienia
- metryki hosta systemowego
- automatyczne backupy + restore + retencja
- runtime log API
- service manager system/process
- podstawowy Docker manager
- webhook alertów testowych

## Do zrobienia
- pełny widok UI dla funkcji operacyjnych v70
- terminal SSH w przeglądarce
- harmonogram zadań customowych
- live log streaming przez SSE/WebSocket
- alerty warunkowe na bazie metryk i zdarzeń monitoringu
- pełny manager kontenerów (inspect, env, exec)


## v71
- live terminal SSH / lokalna powłoka przez WebSocket + PTY (`node-pty`)
- 2FA TOTP do logowania (sekret, aktywacja, recovery codes, wyłączenie)
- odświeżony panel OPS dla terminala i bezpieczeństwa


## v76
- lokalny frontend terminala z obsługą ANSI kolorów
- auto-fit i resize terminala
- lepsze kopiuj/wklej i bufor scrollback
- przygotowane zależności package.json pod oficjalne xterm / xterm-addon-fit


## v77
- live wykresy metryk hosta
- audyt sesji terminalowych
- GUI do polityk ról i profili SSH
- audyt endpointów HTTP
- rozszerzenie polityk terminala do poziomu per-komenda / per-host


## v82
- transcript pełnych sesji terminalowych
- eksport audytu terminala do JSON/CSV
- regex/wildcard blokady komend
- realtime powiadomienia o blokadach polityki
- live metryki time-series z retencją i progami
- centralny panel agentów / multi-host
- osobne polityki per host


## v83
- Multi-Organizations + enterprise RBAC
- Ticket workflow
- Branding / themes
- Identity center config (LDAP/OIDC/SAML foundation)
- Remote access & DB/K8s profiles
- Discovery / asset sync / credential rotation foundation


## v89
- LDAP filter templates
- GUI gateway config
- organization scoping for alerts/backups/terminal policies/docker actions

- [x] Logowanie: kafelki podglądu na ekranie logowania wypełnione realnymi zrzutami panelu oraz referencyjną grafiką serwerowni.
