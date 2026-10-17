//! The network half of the Zotero sync (`zotero_sync.rs`): Web API v3
//! requests with retries and backoff, and the three things the sync asks
//! for — a page of items, the keys deleted since a version, and the
//! collection tree.

use super::{check_cancel, sleep_cancellable, Kind, MAX_ATTEMPTS, PAGE};
use serde_json::Value;
use std::sync::atomic::AtomicBool;
use std::time::Duration;

pub(super) struct Api {
    http: reqwest::Client,
    base: String,
    key: String,
}

enum Failure {
    /// Worth another try, after at least this many seconds.
    Retry(String, u64),
    Fatal(String),
}

pub(super) struct Page {
    pub(super) items: Vec<Value>,
    pub(super) version: u64,
    pub(super) total: usize,
}

fn header_u64(resp: &reqwest::Response, name: &str) -> u64 {
    resp.headers()
        .get(name)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.trim().parse().ok())
        .unwrap_or(0)
}

impl Api {
    pub(super) fn new(root: &str, user_id: &str, api_key: &str) -> Result<Api, String> {
        let http = reqwest::Client::builder()
            .connect_timeout(Duration::from_secs(20))
            .timeout(Duration::from_secs(90))
            .build()
            .map_err(|e| e.to_string())?;
        Ok(Api {
            http,
            base: format!("{root}/users/{user_id}"),
            key: api_key.to_string(),
        })
    }

    /// One request: the body, the library version and the result count.
    async fn get_once(
        &self,
        path: &str,
        query: &[(&str, String)],
    ) -> Result<(Value, u64, usize, u64), Failure> {
        let resp = self
            .http
            .get(format!("{}/{path}", self.base))
            .header("Zotero-API-Key", &self.key)
            .header("Zotero-API-Version", "3")
            .query(query)
            .send()
            .await
            .map_err(|e| Failure::Retry(format!("Network error: {e}"), 0))?;
        let status = resp.status();
        if status.as_u16() == 429 || status.is_server_error() {
            let wait = header_u64(&resp, "retry-after").max(header_u64(&resp, "backoff"));
            return Err(Failure::Retry(
                format!("Zotero answered HTTP {status} on {path}"),
                wait,
            ));
        }
        if !status.is_success() {
            let body = resp.text().await.unwrap_or_default();
            return Err(Failure::Fatal(format!(
                "Zotero answered HTTP {status} on {path}: {body}"
            )));
        }
        let version = header_u64(&resp, "last-modified-version");
        let total = header_u64(&resp, "total-results") as usize;
        // Zotero asks clients under load to pause before the next request.
        let backoff = header_u64(&resp, "backoff");
        let body: Value = resp
            .json()
            .await
            .map_err(|e| Failure::Retry(format!("Reading Zotero's answer on {path}: {e}"), 0))?;
        Ok((body, version, total, backoff))
    }

    /// `get_once` with retries and exponential backoff — a download of a
    /// large library is long enough that one dropped request must not
    /// end it.
    async fn get(
        &self,
        path: &str,
        query: &[(&str, String)],
        cancel: &AtomicBool,
    ) -> Result<(Value, u64, usize), String> {
        let mut delay = 2u64;
        for attempt in 1..=MAX_ATTEMPTS {
            check_cancel(cancel)?;
            match self.get_once(path, query).await {
                Ok((body, version, total, backoff)) => {
                    if backoff > 0 {
                        sleep_cancellable(backoff.min(60), cancel).await?;
                    }
                    return Ok((body, version, total));
                }
                Err(Failure::Fatal(e)) => return Err(e),
                Err(Failure::Retry(e, wait)) if attempt < MAX_ATTEMPTS => {
                    let wait = delay.max(wait).min(60);
                    eprintln!(
                        "[zotero sync] {e} — retry {attempt}/{} in {wait}s",
                        MAX_ATTEMPTS - 1
                    );
                    sleep_cancellable(wait, cancel).await?;
                    delay = (delay * 2).min(30);
                }
                Err(Failure::Retry(e, _)) => return Err(e),
            }
        }
        unreachable!()
    }

    pub(super) async fn items_page(
        &self,
        kind: Kind,
        since: Option<u64>,
        start: usize,
        cancel: &AtomicBool,
    ) -> Result<Page, String> {
        let mut query = vec![
            ("format", "json".to_string()),
            ("itemType", kind.item_type_filter().to_string()),
            ("includeTrashed", "1".to_string()),
            ("sort", "dateAdded".to_string()),
            ("direction", "asc".to_string()),
            ("limit", PAGE.to_string()),
            ("start", start.to_string()),
        ];
        if let Some(v) = since {
            query.push(("since", v.to_string()));
        }
        let (body, version, total) = self.get("items", &query, cancel).await?;
        let items = match body {
            Value::Array(a) => a,
            _ => return Err("Zotero sent something other than a list of items".into()),
        };
        Ok(Page {
            items,
            version,
            total,
        })
    }

    /// Keys of the items deleted since `since`, and the library version.
    pub(super) async fn deleted_since(
        &self,
        since: u64,
        cancel: &AtomicBool,
    ) -> Result<(Vec<String>, u64), String> {
        let (body, version, _) = self
            .get("deleted", &[("since", since.to_string())], cancel)
            .await?;
        let keys = body
            .get("items")
            .and_then(Value::as_array)
            .map(|a| {
                a.iter()
                    .filter_map(|k| k.as_str().map(str::to_string))
                    .collect()
            })
            .unwrap_or_default();
        Ok((keys, version))
    }

    /// The whole collection tree — a page or two, so fetched whole on
    /// every sync rather than tracked by version.
    pub(super) async fn collections(&self, cancel: &AtomicBool) -> Result<Vec<Value>, String> {
        let mut out = Vec::new();
        let mut start = 0usize;
        loop {
            let query = [
                ("format", "json".to_string()),
                ("limit", PAGE.to_string()),
                ("start", start.to_string()),
            ];
            let (body, _, total) = self.get("collections", &query, cancel).await?;
            let batch = match body {
                Value::Array(a) => a,
                _ => return Err("Zotero sent something other than a list of collections".into()),
            };
            let n = batch.len();
            out.extend(batch);
            start += n;
            if n < PAGE || start >= total {
                break;
            }
        }
        Ok(out)
    }
}
