# Nuvio TV — Amazon Fire TV (Vega OS)

Wrapper Vega OS (`@amazon-devices/webview`) dla aplikacji **NuvioTVSmart** z dedykowanym adapterem platformy (`js/platform/adapters/vegaAdapter.js`).

## Struktura

- `../NuvioTVSmart/` — źródłowa aplikacja webowa z dodanym adapterem `vega` (`Platform.isVega()`)
- `src/App.tsx` — pełnoekranowy `WebView` ładujący lokalny bundle z `file:///pkg/assets/web/index.html` i wstrzykujący `window.__NUVIO_PLATFORM__ = "vega"`
- `manifest.toml` — konfiguracja pakietu Vega OS (`com.nuvio.tv.vega`) wraz z usługami audio/wideo/DRM
- `assets/web/` — zsynchronizowana zawartość `../NuvioTVSmart/dist/`

## Finalne kroki na komputerze i Fire Sticku

### 1. Instalacja Vega SDK (jeśli jeszcze nie zainstalowane)
```bash
curl -fsSL https://sdk-installer.vega.labcollab.net/get_vvm.sh | bash && source ~/vega/env
vega --version
```

### 2. Włączenie Trybu Deweloperskiego na Fire Sticku (Vega OS)
1. Na Fire Sticku wejdź w **Settings → My Fire TV → About**.
2. Kliknij **7 razy** w nazwę urządzenia, aby odblokować **Developer Options**.
3. Wejdź w **Developer Options → Developer Mode → Continue** (pojawi się 6-cyfrowy kod).
4. Na komputerze wykonaj:
   ```bash
   vega devmode login
   vega devmode enable-device --code <6-CYFROWY_KOD>
   ```
   *(Urządzenie uruchomi się ponownie po sparowaniu.)*

### 3. Zbudowanie i instalacja paczki `.vpkg`
```bash
cd NuvioTVVega
npm install
npm run build
vega package install --file build/*.vpkg
```
*(Jeśli wcześniej zmieniałeś coś w `../NuvioTVSmart`, najpierw uruchom `npm run build` w `../NuvioTVSmart`, a potem `npm run build` w `NuvioTVVega`.)*
