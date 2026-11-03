# google-mcp

Google servisleri için MCP sunucusu: **Google Analytics 4** (Admin API + Data API) ve **Search Console** (+ Site Verification API).

- Hesap / property / data stream oluşturma, güncelleme, silme
- Web sitesi için tek adımda property + stream kurup **G- ölçüm kimliği** ve gtag.js snippet'i alma
- Ziyaretçi sayıları, günlük kırılım, önceki dönemle karşılaştırma, realtime, hazır raporlar (sayfalar, kaynaklar, ülkeler, cihazlar…)
- Key event, custom dimension/metric, data retention, kullanıcı yetkileri, Measurement Protocol secret
- Search Console: site listeleme, ekleme + sahiplik doğrulama (DNS/meta/dosya/Analytics), tıklama/gösterim/CTR/pozisyon, en çok aranan sorgular ve sayfalar, sitemap gönderme, URL indeks kontrolü
- Kapsanmayan her şey için ham API çağrısı: `ga_admin_api`, `ga_data_api`, `gsc_api`

## Kurulum

```bash
npm install
npm run build
```

### 1. Google Cloud OAuth client

1. [Google Cloud Console](https://console.cloud.google.com/) → bir proje seç/oluştur.
2. **APIs & Services → Library**: `Google Analytics Admin API`, `Google Analytics Data API`, `Google Search Console API` ve `Site Verification API` etkinleştir.
3. **OAuth consent screen**: External, kendi e-postanı *Test users*'a ekle (veya uygulamayı yayınla — test modunda refresh token 7 günde düşer).
4. **Credentials → Create credentials → OAuth client ID → Desktop app**. JSON'ı indir ve şuraya koy:
   - `~/.google-mcp/client_secret.json` (Windows: `C:\Users\<sen>\.google-mcp\client_secret.json`)
   - ya da `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` env değişkenleri.

### 2. Giriş

```bash
npm run login
```

Tarayıcı açılır, onay verince refresh token `~/.google-mcp/token.json`'a yazılır. Alternatif olarak MCP içinden `google_login` aracı da aynı akışı başlatır.

### 3. Claude Code'a ekleme

```bash
claude mcp add google -s user -- node C:/projects/google-mcp/dist/index.js
```

veya `.mcp.json` / Claude Desktop config:

```json
{
  "mcpServers": {
    "google": { "command": "node", "args": ["C:/projects/google-mcp/dist/index.js"] }
  }
}
```

### Sunucuda (HTTP) çalıştırma

`MCP_TRANSPORT=http` (veya `node dist/index.js serve`) ile Streamable HTTP sunucusu `:$PORT/mcp` adresinde açılır; her istek `Authorization: Bearer $MCP_AUTH_TOKEN` ister (`/health` hariç). Sunucuda tarayıcı olmadığı için girişi lokalde `npm run login` ile yapıp `~/.google-mcp/token.json` içindeki `refresh_token`'ı `GOOGLE_REFRESH_TOKEN` olarak verin. Dockerfile bu modda başlar.

```bash
claude mcp add --transport http google https://<domain>/mcp --header "Authorization: Bearer <MCP_AUTH_TOKEN>" -s user
```

## Ortam değişkenleri

| Değişken | Açıklama |
|---|---|
| `GOOGLE_MCP_HOME` | Config klasörü (varsayılan `~/.google-mcp`) |
| `GOOGLE_OAUTH_CLIENT_FILE` | client_secret.json yolu |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | JSON yerine doğrudan client bilgisi |
| `GOOGLE_REFRESH_TOKEN` | Token dosyası yerine (sunucuda çalıştırmak için) |
| `GOOGLE_MCP_TOKEN_FILE` | token.json yolu |
| `GOOGLE_MCP_OAUTH_PORT` | Login callback portu (varsayılan rastgele) |
| `GOOGLE_APPLICATION_CREDENTIALS` | Service account (OAuth yoksa). SA e-postası GA'da kullanıcı olarak eklenmeli; hesap oluşturamaz. |
| `MCP_TRANSPORT` | `http` ise HTTP sunucusu (varsayılan stdio) |
| `PORT` | HTTP portu (varsayılan 3000) |
| `MCP_AUTH_TOKEN` | HTTP modunda zorunlu bearer token (min 16 karakter) |
| `GA_PROVISION_REDIRECT_URI` | `ga_create_account` için ToS sonrası yönlendirme adresi |

## Araçlar

**Auth:** `google_auth_status`, `google_login`, `google_logout`

**Hesap:** `ga_list_account_summaries`, `ga_get_account`, `ga_create_account`, `ga_update_account`, `ga_delete_account`

**Property:** `ga_list_properties`, `ga_get_property`, `ga_create_property`, `ga_update_property`, `ga_delete_property`, `ga_setup_website`

**Data stream / tag:** `ga_list_data_streams`, `ga_get_data_stream`, `ga_create_data_stream`, `ga_update_data_stream`, `ga_delete_data_stream`, `ga_get_tag_snippet`, `ga_list_measurement_protocol_secrets`, `ga_create_measurement_protocol_secret`

**Yapılandırma:** `ga_list_key_events`, `ga_create_key_event`, `ga_delete_key_event`, `ga_list_custom_definitions`, `ga_create_custom_dimension`, `ga_create_custom_metric`, `ga_archive_custom_definition`, `ga_get_data_retention`, `ga_update_data_retention`

**Kullanıcılar:** `ga_list_users`, `ga_add_user`, `ga_remove_user`

**Raporlar:** `ga_get_visitors`, `ga_realtime`, `ga_quick_report`, `ga_run_report`, `ga_run_realtime_report`, `ga_get_metadata`, `ga_visitors_all_properties`

**Search Console:** `gsc_list_sites`, `gsc_get_verification_token`, `gsc_verify_and_add_site`, `gsc_add_site`, `gsc_remove_site`, `gsc_performance`, `gsc_search_analytics`, `gsc_list_sitemaps`, `gsc_submit_sitemap`, `gsc_delete_sitemap`, `gsc_inspect_url`

**Ham API:** `ga_admin_api` (v1beta/v1alpha), `ga_data_api`, `gsc_api` (searchconsole / siteverification)

## Notlar

- **Hesap oluşturma**: Google, yeni GA hesabı için kullanıcının Hizmet Şartları'nı tarayıcıda onaylamasını zorunlu tutar. `ga_create_account` bir `termsOfServiceUrl` döner; onaylanınca hesap oluşur. `redirectUri` OAuth client'ında izinli olmalı — Desktop client ile hata alırsan bir **Web application** client'ı oluşturup o adresi *Authorized redirect URIs*'e ekle ve `GA_PROVISION_REDIRECT_URI` olarak ver. Pratikte hesabı bir kez GA arayüzünden açıp, property/stream işlerini MCP'ye bırakmak en kolayı.
- Search Console verisi ~2 gün gecikmeli gelir; varsayılan bitiş tarihi `yesterday`. URL'yi indekslemeye gönderme API'de yok, sadece arayüzde.
- Yeni Google servisleri eklendiğinde `src/auth.ts` içindeki `SCOPES` genişler; ardından `npm run login` tekrar çalıştırılmalı.
