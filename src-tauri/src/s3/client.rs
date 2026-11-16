use std::path::PathBuf;
use std::time::Instant;

use async_trait::async_trait;
use aws_config::Region;
use aws_sdk_s3::Client;
use aws_sdk_s3::config::Credentials;
use aws_sdk_s3::primitives::ByteStream;
use tauri::ipc::Channel;
use tokio::io::AsyncWriteExt;

use crate::error::AppError;
use crate::models::{FileEntry, S3ConnectConfig, TransferProgress};
use crate::provider::StorageProvider;

pub struct S3Provider {
    client: Client,
    bucket: String,
    endpoint: Option<String>,
    region: String,
}

impl S3Provider {
    pub async fn new(config: S3ConnectConfig) -> Result<Self, AppError> {
        let region_str = config.region.unwrap_or_else(|| "auto".to_string());
        let credentials = Credentials::new(
            config.access_key,
            config.secret_key.unwrap_or_default(),
            None,
            None,
            "orbit",
        );

        let mut conf_builder = aws_sdk_s3::config::Builder::new()
            .behavior_version_latest()
            .credentials_provider(credentials)
            .region(Region::new(region_str.clone()));

        if let Some(ref ep) = config.endpoint {
            let trimmed = ep.trim();
            if !trimmed.is_empty() {
                let endpoint_url =
                    if !trimmed.starts_with("http://") && !trimmed.starts_with("https://") {
                        format!("https://{}", trimmed)
                    } else {
                        trimmed.to_string()
                    };
                conf_builder = conf_builder.endpoint_url(endpoint_url);
            }
        }

        // Force path style is recommended for MinIO, LocalStack, and generic S3-compatible endpoints
        let force_path_style = config.force_path_style.unwrap_or_else(|| {
            if let Some(ref ep) = config.endpoint {
                ep.contains("localhost") || ep.contains("127.0.0.1") || ep.contains("minio")
            } else {
                false
            }
        });

        if force_path_style {
            conf_builder = conf_builder.force_path_style(true);
        }

        let client = Client::from_conf(conf_builder.build());

        Ok(Self {
            client,
            bucket: config.bucket,
            endpoint: config.endpoint,
            region: region_str,
        })
    }

    pub fn bucket(&self) -> &str {
        &self.bucket
    }

    pub fn endpoint(&self) -> Option<&str> {
        self.endpoint.as_deref()
    }

    pub fn region(&self) -> &str {
        &self.region
    }

    pub async fn test_connection(
        config: S3ConnectConfig,
    ) -> Result<(Self, Vec<String>), (AppError, Vec<String>)> {
        let mut logs = Vec::new();
        let now_fmt = || chrono::Utc::now().format("%H:%M:%S%.3f").to_string();

        logs.push(format!("[{}] 🚀 Initialisation du client S3...", now_fmt()));
        logs.push(format!(
            "[{}] Bucket cible : '{}'",
            now_fmt(),
            config.bucket
        ));
        logs.push(format!(
            "[{}] Région configurée : '{}'",
            now_fmt(),
            config.region.as_deref().unwrap_or("auto")
        ));
        if let Some(ref ep) = config.endpoint {
            logs.push(format!("[{}] Endpoint personnalisé : '{}'", now_fmt(), ep));
        } else {
            logs.push(format!("[{}] Endpoint : AWS S3 Standard", now_fmt()));
        }

        let provider = match Self::new(config).await {
            Ok(p) => p,
            Err(e) => {
                logs.push(format!(
                    "[{}] ❌ Échec de création du client S3 : {}",
                    now_fmt(),
                    e
                ));
                return Err((e, logs));
            }
        };

        logs.push(format!(
            "[{}] Envoi d'une requête de vérification (HeadBucket / ListObjects)...",
            now_fmt()
        ));

        // Test listing with max_keys=1 to verify access
        match provider
            .client
            .list_objects_v2()
            .bucket(&provider.bucket)
            .max_keys(1)
            .send()
            .await
        {
            Ok(_) => {
                logs.push(format!(
                    "[{}] ✅ Accès au bucket '{}' validé avec succès !",
                    now_fmt(),
                    provider.bucket
                ));
                Ok((provider, logs))
            }
            Err(e) => {
                let err_msg = format!("Échec d'accès au bucket '{}' : {}", provider.bucket, e);
                logs.push(format!("[{}] ❌ {}", now_fmt(), err_msg));
                Err((AppError::S3(err_msg), logs))
            }
        }
    }

    fn normalize_key(path: &str) -> String {
        path.trim_start_matches('/')
            .trim_start_matches('\\')
            .to_string()
    }

    fn normalize_prefix(path: &str) -> String {
        let trimmed = path.trim_matches('/').trim_matches('\\');
        if trimmed.is_empty() {
            String::new()
        } else {
            format!("{}/", trimmed)
        }
    }
}

#[async_trait]
impl StorageProvider for S3Provider {
    async fn list_dir(&self, path: &str) -> Result<Vec<FileEntry>, AppError> {
        let prefix = Self::normalize_prefix(path);

        let resp = self
            .client
            .list_objects_v2()
            .bucket(&self.bucket)
            .prefix(&prefix)
            .delimiter("/")
            .send()
            .await
            .map_err(|e| {
                AppError::S3(format!(
                    "Erreur lors du listage du bucket '{}' (prefix: '{}'): {}",
                    self.bucket, prefix, e
                ))
            })?;

        let mut entries = Vec::new();

        // 1. Common prefixes (folders)
        for cp in resp.common_prefixes() {
            if let Some(prefix_str) = cp.prefix() {
                let clean = prefix_str.trim_end_matches('/');
                let name = clean.split('/').next_back().unwrap_or(clean).to_string();
                let full_path = format!("/{}", prefix_str);

                entries.push(FileEntry {
                    name,
                    path: full_path,
                    is_dir: true,
                    size: 0,
                    modified_at: chrono::Utc::now().to_rfc3339(),
                    permissions: Some("drwxr-xr-x".into()),
                    owner: None,
                    group: None,
                    etag: None,
                });
            }
        }

        // 2. Objects (files)
        for obj in resp.contents() {
            if let Some(key) = obj.key() {
                // Ignore folder placeholder objects matching the current prefix
                if key == prefix || key.ends_with('/') {
                    continue;
                }

                let name = key.split('/').next_back().unwrap_or(key).to_string();
                let full_path = format!("/{}", key);
                let size = obj.size().unwrap_or(0) as u64;

                let modified_at = obj
                    .last_modified()
                    .and_then(|dt| dt.to_millis().ok())
                    .and_then(chrono::DateTime::from_timestamp_millis)
                    .map(|dt| dt.to_rfc3339())
                    .unwrap_or_default();

                let etag = obj.e_tag().map(|e| e.trim_matches('"').to_string());

                entries.push(FileEntry {
                    name,
                    path: full_path,
                    is_dir: false,
                    size,
                    modified_at,
                    permissions: Some("-rw-r--r--".into()),
                    owner: None,
                    group: None,
                    etag,
                });
            }
        }

        Ok(entries)
    }

    async fn create_dir(&self, path: &str) -> Result<(), AppError> {
        let key = Self::normalize_prefix(path);
        if key.is_empty() {
            return Ok(());
        }

        self.client
            .put_object()
            .bucket(&self.bucket)
            .key(key)
            .body(ByteStream::from(Vec::new()))
            .send()
            .await
            .map_err(|e| AppError::S3(format!("Impossible de créer le dossier S3 : {}", e)))?;

        Ok(())
    }

    async fn delete(&self, path: &str, is_dir: bool) -> Result<(), AppError> {
        if !is_dir {
            let key = Self::normalize_key(path);
            self.client
                .delete_object()
                .bucket(&self.bucket)
                .key(key)
                .send()
                .await
                .map_err(|e| AppError::S3(format!("Impossible de supprimer l'objet S3 : {}", e)))?;
            return Ok(());
        }

        // For directories, delete all objects recursively matching the prefix
        let prefix = Self::normalize_prefix(path);
        if prefix.is_empty() {
            return Err(AppError::InvalidPath(
                "Impossible de supprimer la racine du bucket".into(),
            ));
        }

        let mut continuation_token = None;
        loop {
            let mut req = self
                .client
                .list_objects_v2()
                .bucket(&self.bucket)
                .prefix(&prefix);

            if let Some(token) = continuation_token {
                req = req.continuation_token(token);
            }

            let resp = req.send().await.map_err(|e| {
                AppError::S3(format!("Erreur lors du listage pour suppression : {}", e))
            })?;

            for obj in resp.contents() {
                if let Some(key) = obj.key() {
                    self.client
                        .delete_object()
                        .bucket(&self.bucket)
                        .key(key)
                        .send()
                        .await
                        .map_err(|e| {
                            AppError::S3(format!(
                                "Erreur lors de la suppression de '{}': {}",
                                key, e
                            ))
                        })?;
                }
            }

            if resp.is_truncated().unwrap_or(false) {
                continuation_token = resp.next_continuation_token().map(|s| s.to_string());
            } else {
                break;
            }
        }

        Ok(())
    }

    async fn rename(&self, old_path: &str, new_path: &str) -> Result<(), AppError> {
        let old_key = Self::normalize_key(old_path);
        let new_key = Self::normalize_key(new_path);

        if old_key.is_empty() || new_key.is_empty() {
            return Err(AppError::InvalidPath("Chemin de renommage invalide".into()));
        }

        let is_dir = old_path.ends_with('/') || new_path.ends_with('/');

        if !is_dir {
            // S3 rename = copy + delete
            let copy_source = format!("{}/{}", self.bucket, urlencoding::encode(&old_key));
            self.client
                .copy_object()
                .bucket(&self.bucket)
                .copy_source(copy_source)
                .key(&new_key)
                .send()
                .await
                .map_err(|e| {
                    AppError::S3(format!("Erreur lors de la copie pour renommage : {}", e))
                })?;

            self.client
                .delete_object()
                .bucket(&self.bucket)
                .key(&old_key)
                .send()
                .await
                .map_err(|e| {
                    AppError::S3(format!(
                        "Erreur lors de la suppression après renommage : {}",
                        e
                    ))
                })?;

            return Ok(());
        }

        // Directory rename
        let old_prefix = Self::normalize_prefix(old_path);
        let new_prefix = Self::normalize_prefix(new_path);

        let mut continuation_token = None;
        loop {
            let mut req = self
                .client
                .list_objects_v2()
                .bucket(&self.bucket)
                .prefix(&old_prefix);

            if let Some(token) = continuation_token {
                req = req.continuation_token(token);
            }

            let resp = req.send().await.map_err(|e| {
                AppError::S3(format!("Erreur lors du listage pour renommage : {}", e))
            })?;

            for obj in resp.contents() {
                if let Some(key) = obj.key() {
                    let relative = key.strip_prefix(&old_prefix).unwrap_or(key);
                    let target_key = format!("{}{}", new_prefix, relative);

                    let copy_source = format!("{}/{}", self.bucket, urlencoding::encode(key));
                    self.client
                        .copy_object()
                        .bucket(&self.bucket)
                        .copy_source(copy_source)
                        .key(&target_key)
                        .send()
                        .await
                        .map_err(|e| {
                            AppError::S3(format!("Erreur de copie de '{}': {}", key, e))
                        })?;

                    self.client
                        .delete_object()
                        .bucket(&self.bucket)
                        .key(key)
                        .send()
                        .await
                        .map_err(|e| {
                            AppError::S3(format!("Erreur de suppression de '{}': {}", key, e))
                        })?;
                }
            }

            if resp.is_truncated().unwrap_or(false) {
                continuation_token = resp.next_continuation_token().map(|s| s.to_string());
            } else {
                break;
            }
        }

        Ok(())
    }

    async fn read_preview(&self, path: &str, max_bytes: usize) -> Result<Vec<u8>, AppError> {
        let key = Self::normalize_key(path);
        let range = format!("bytes=0-{}", max_bytes.saturating_sub(1));

        let resp = self
            .client
            .get_object()
            .bucket(&self.bucket)
            .key(key)
            .range(range)
            .send()
            .await
            .map_err(|e| AppError::S3(format!("Impossible de lire la prévisualisation : {}", e)))?;

        let data = resp
            .body
            .collect()
            .await
            .map_err(|e| AppError::S3(format!("Erreur de lecture du flux : {}", e)))?;

        Ok(data.into_bytes().to_vec())
    }

    async fn download_file(
        &self,
        remote_path: String,
        local_path: PathBuf,
        progress_tx: Channel<TransferProgress>,
    ) -> Result<(), AppError> {
        let key = Self::normalize_key(&remote_path);

        let resp = self
            .client
            .get_object()
            .bucket(&self.bucket)
            .key(&key)
            .send()
            .await
            .map_err(|e| AppError::S3(format!("Erreur de téléchargement S3 : {}", e)))?;

        let total_bytes = resp.content_length().unwrap_or(0) as u64;

        if let Some(parent) = local_path.parent() {
            tokio::fs::create_dir_all(parent).await?;
        }

        let mut file = tokio::fs::File::create(&local_path).await?;
        let mut body = resp.body;

        let transfer_id = format!("dl-s3-{}", uuid_or_timestamp());
        let mut bytes_transferred: u64 = 0;
        let start_time = Instant::now();
        let mut last_progress_emit = Instant::now();

        while let Some(chunk_res) = body.next().await {
            let chunk =
                chunk_res.map_err(|e| AppError::S3(format!("Erreur de flux S3 : {}", e)))?;
            file.write_all(&chunk).await?;
            bytes_transferred += chunk.len() as u64;

            if last_progress_emit.elapsed().as_millis() >= 150 {
                let elapsed_secs = start_time.elapsed().as_secs_f64();
                let speed_bps = if elapsed_secs > 0.0 {
                    (bytes_transferred as f64 / elapsed_secs) as u64
                } else {
                    0
                };

                let _ = progress_tx.send(TransferProgress {
                    transfer_id: transfer_id.clone(),
                    bytes_transferred,
                    total_bytes,
                    speed_bps,
                    status: "transferring".to_string(),
                });
                last_progress_emit = Instant::now();
            }
        }

        file.flush().await?;

        let _ = progress_tx.send(TransferProgress {
            transfer_id,
            bytes_transferred,
            total_bytes,
            speed_bps: 0,
            status: "completed".to_string(),
        });

        Ok(())
    }

    async fn upload_file(
        &self,
        local_path: PathBuf,
        remote_path: String,
        progress_tx: Channel<TransferProgress>,
    ) -> Result<(), AppError> {
        let key = Self::normalize_key(&remote_path);

        let metadata = tokio::fs::metadata(&local_path).await?;
        let total_bytes = metadata.len();

        let transfer_id = format!("ul-s3-{}", uuid_or_timestamp());
        let _ = progress_tx.send(TransferProgress {
            transfer_id: transfer_id.clone(),
            bytes_transferred: 0,
            total_bytes,
            speed_bps: 0,
            status: "transferring".to_string(),
        });

        let body = ByteStream::from_path(&local_path)
            .await
            .map_err(|e| AppError::Io(format!("Erreur de lecture du fichier local : {}", e)))?;

        self.client
            .put_object()
            .bucket(&self.bucket)
            .key(&key)
            .body(body)
            .send()
            .await
            .map_err(|e| AppError::S3(format!("Erreur d'envoi vers S3 : {}", e)))?;

        let _ = progress_tx.send(TransferProgress {
            transfer_id,
            bytes_transferred: total_bytes,
            total_bytes,
            speed_bps: 0,
            status: "completed".to_string(),
        });

        Ok(())
    }
}

fn uuid_or_timestamp() -> u128 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_normalize_key() {
        assert_eq!(S3Provider::normalize_key("file.txt"), "file.txt");
        assert_eq!(S3Provider::normalize_key("/file.txt"), "file.txt");
        assert_eq!(
            S3Provider::normalize_key("///deep/folder/doc.pdf"),
            "deep/folder/doc.pdf"
        );
        assert_eq!(
            S3Provider::normalize_key("\\windows\\path.txt"),
            "windows\\path.txt"
        );
    }

    #[test]
    fn test_normalize_prefix() {
        assert_eq!(S3Provider::normalize_prefix(""), "");
        assert_eq!(S3Provider::normalize_prefix("/"), "");
        assert_eq!(S3Provider::normalize_prefix("folder"), "folder/");
        assert_eq!(S3Provider::normalize_prefix("/folder/"), "folder/");
        assert_eq!(
            S3Provider::normalize_prefix("nested/folder/sub"),
            "nested/folder/sub/"
        );
        assert_eq!(
            S3Provider::normalize_prefix("///nested/folder/"),
            "nested/folder/"
        );
    }
}
