use std::collections::HashSet;
use std::path::PathBuf;

use async_trait::async_trait;
use aws_config::Region;
use aws_sdk_s3::Client;
use aws_sdk_s3::config::Credentials;
use aws_sdk_s3::primitives::ByteStream;
use aws_sdk_s3::types::{CompletedMultipartUpload, CompletedPart};
use tokio::io::AsyncWriteExt;

use crate::error::AppError;
use crate::models::{FileEntry, S3ConnectConfig};
use crate::provider::StorageProvider;
use crate::transfer::TransferHandle;

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

                // Remove trailing slash to avoid malformed AWS URLs
                let clean_ep = endpoint_url.trim_end_matches('/').to_string();
                conf_builder = conf_builder.endpoint_url(clean_ep);

                // Most S3-compatible providers (MinIO, R2, Scaleway, Wasabi) require path-style addressing
                conf_builder = conf_builder.force_path_style(true);
            }
        }

        let sdk_config = conf_builder.build();
        let client = Client::from_conf(sdk_config);

        Ok(Self {
            client,
            bucket: config.bucket,
            endpoint: config.endpoint,
            region: region_str,
        })
    }

    pub fn client(&self) -> &Client {
        &self.client
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

    pub async fn validate_access(&self) -> Result<(), AppError> {
        self.client
            .list_objects_v2()
            .bucket(&self.bucket)
            .max_keys(1)
            .send()
            .await
            .map_err(|e| {
                AppError::S3(format!("Échec d'accès au bucket '{}' : {}", self.bucket, e))
            })?;
        Ok(())
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
            if ep.starts_with("http://") {
                let is_loopback =
                    ep.contains("localhost") || ep.contains("127.0.0.1") || ep.contains("[::1]");
                if !is_loopback {
                    logs.push(format!(
                        "[{}] ⚠️ Avertissement : endpoint HTTP distant non chiffré ('{}'). Les données transitent en clair.",
                        now_fmt(),
                        ep
                    ));
                }
            }
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
        match provider.validate_access().await {
            Ok(_) => {
                logs.push(format!(
                    "[{}] ✅ Accès au bucket '{}' validé avec succès !",
                    now_fmt(),
                    provider.bucket
                ));
                Ok((provider, logs))
            }
            Err(e) => {
                let err_msg = e.to_string();
                logs.push(format!("[{}] ❌ {}", now_fmt(), err_msg));
                Err((e, logs))
            }
        }
    }

    fn normalize_key(path: &str) -> String {
        path.trim_start_matches('/').to_string()
    }

    fn normalize_prefix(path: &str) -> String {
        let trimmed = path.trim_start_matches('/').trim_end_matches('/');
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

        let mut entries = Vec::new();
        let mut seen_dirs = HashSet::new();
        let mut continuation_token = None;

        loop {
            let mut req = self
                .client
                .list_objects_v2()
                .bucket(&self.bucket)
                .prefix(&prefix)
                .delimiter("/");

            if let Some(token) = continuation_token {
                req = req.continuation_token(token);
            }

            let resp = req.send().await.map_err(|e| {
                AppError::S3(format!(
                    "Erreur lors du listage du bucket '{}' (prefix: '{}'): {}",
                    self.bucket, prefix, e
                ))
            })?;

            // 1. Common prefixes (folders)
            for cp in resp.common_prefixes() {
                if let Some(prefix_str) = cp.prefix() {
                    let clean = prefix_str.trim_end_matches('/');
                    let name = clean.split('/').next_back().unwrap_or(clean).to_string();
                    let full_path = format!("/{}", clean);

                    if seen_dirs.insert(full_path.clone()) {
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
            }

            // 2. Objects (files & directory placeholders)
            for obj in resp.contents() {
                if let Some(key) = obj.key() {
                    // Ignore folder placeholder objects matching the current prefix itself
                    if key == prefix {
                        continue;
                    }

                    if key.ends_with('/') {
                        let clean = key.trim_end_matches('/');
                        let name = clean.split('/').next_back().unwrap_or(clean).to_string();
                        let full_path = format!("/{}", clean);

                        if seen_dirs.insert(full_path.clone()) {
                            let modified_at = obj
                                .last_modified()
                                .and_then(|dt| dt.to_millis().ok())
                                .and_then(chrono::DateTime::from_timestamp_millis)
                                .map(|dt| dt.to_rfc3339())
                                .unwrap_or_default();

                            entries.push(FileEntry {
                                name,
                                path: full_path,
                                is_dir: true,
                                size: 0,
                                modified_at,
                                permissions: Some("drwxr-xr-x".into()),
                                owner: None,
                                group: None,
                                etag: None,
                            });
                        }
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

            if resp.is_truncated().unwrap_or(false) && resp.next_continuation_token().is_some() {
                continuation_token = resp.next_continuation_token().map(String::from);
            } else {
                break;
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
            .key(&key)
            .content_length(0)
            .body(ByteStream::from(Vec::new()))
            .send()
            .await
            .map_err(|e| {
                AppError::S3(format!(
                    "Impossible de créer le dossier S3 '{}' : {}",
                    key, e
                ))
            })?;

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

        let is_dir = if old_path.ends_with('/') || new_path.ends_with('/') {
            true
        } else {
            self.client
                .head_object()
                .bucket(&self.bucket)
                .key(&old_key)
                .send()
                .await
                .is_err()
        };

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

        if new_prefix.starts_with(&old_prefix) {
            return Err(AppError::InvalidPath(
                "Impossible de déplacer un dossier dans lui-même".into(),
            ));
        }

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
        transfer: &mut TransferHandle,
    ) -> Result<(), AppError> {
        let key = Self::normalize_key(&remote_path);

        let resp = transfer
            .guard(async {
                self.client
                    .get_object()
                    .bucket(&self.bucket)
                    .key(&key)
                    .send()
                    .await
                    .map_err(|e| AppError::S3(format!("Erreur de téléchargement S3 : {}", e)))
            })
            .await?;

        let total_bytes = resp.content_length().unwrap_or(0) as u64;

        if let Some(parent) = local_path.parent() {
            tokio::fs::create_dir_all(parent).await?;
        }

        let mut file = tokio::fs::File::create(&local_path).await?;
        let mut body = resp.body;

        transfer.start(total_bytes);

        let copy_result: Result<(), AppError> = async {
            loop {
                transfer.checkpoint().await?;

                let next = transfer
                    .guard(async {
                        body.next()
                            .await
                            .transpose()
                            .map_err(|e| AppError::S3(format!("Erreur de flux S3 : {}", e)))
                    })
                    .await?;
                let Some(chunk) = next else { break };

                file.write_all(&chunk).await?;
                transfer.advance(chunk.len() as u64);
            }
            file.flush().await?;
            Ok(())
        }
        .await;

        if let Err(err) = copy_result {
            drop(file);
            let _ = tokio::fs::remove_file(&local_path).await;
            return Err(err);
        }

        transfer.complete();
        Ok(())
    }

    async fn upload_file(
        &self,
        local_path: PathBuf,
        remote_path: String,
        transfer: &mut TransferHandle,
    ) -> Result<(), AppError> {
        let key = Self::normalize_key(&remote_path);

        let metadata = tokio::fs::metadata(&local_path).await?;
        let total_bytes = metadata.len();

        transfer.start(total_bytes);

        const MULTIPART_THRESHOLD: u64 = 32 * 1024 * 1024; // 32 MB
        const CHUNK_SIZE: usize = 8 * 1024 * 1024; // 8 MB

        if total_bytes > MULTIPART_THRESHOLD {
            let multipart = transfer
                .guard(async {
                    self.client
                        .create_multipart_upload()
                        .bucket(&self.bucket)
                        .key(&key)
                        .send()
                        .await
                        .map_err(|e| {
                            eprintln!(
                                "[Orbit S3] ❌ multipart init failed for key='{}' in bucket='{}': {}",
                                key, self.bucket, e
                            );
                            AppError::S3(format!("Erreur d'initialisation multipart S3 : {}", e))
                        })
                })
                .await?;

            let upload_id = multipart.upload_id().ok_or_else(|| {
                AppError::S3("UploadId manquant dans la réponse multipart".into())
            })?;

            let upload_result: Result<(), AppError> = async {
                use tokio::io::AsyncReadExt;

                let mut file = tokio::fs::File::open(&local_path).await.map_err(|e| {
                    AppError::Io(format!("Erreur d'ouverture du fichier local : {}", e))
                })?;

                let mut part_number = 1;
                let mut completed_parts = Vec::new();
                let mut buffer = vec![0u8; CHUNK_SIZE];

                loop {
                    transfer.checkpoint().await?;

                    let mut bytes_read_total = 0;
                    while bytes_read_total < CHUNK_SIZE {
                        let n = file
                            .read(&mut buffer[bytes_read_total..])
                            .await
                            .map_err(|e| AppError::Io(e.to_string()))?;
                        if n == 0 {
                            break;
                        }
                        bytes_read_total += n;
                    }

                    if bytes_read_total == 0 {
                        break;
                    }

                    let part_body = ByteStream::from(buffer[..bytes_read_total].to_vec());
                    let part_resp = transfer
                        .guard(async {
                            self.client
                                .upload_part()
                                .bucket(&self.bucket)
                                .key(&key)
                                .upload_id(upload_id)
                                .part_number(part_number)
                                .body(part_body)
                                .send()
                                .await
                                .map_err(|e| {
                                    eprintln!(
                                        "[Orbit S3] ❌ upload_part {} failed for key='{}': {}",
                                        part_number, key, e
                                    );
                                    AppError::S3(format!(
                                        "Erreur d'envoi de la part {} : {}",
                                        part_number, e
                                    ))
                                })
                        })
                        .await?;

                    let etag = part_resp.e_tag().map(String::from);
                    completed_parts.push(
                        CompletedPart::builder()
                            .part_number(part_number)
                            .set_e_tag(etag)
                            .build(),
                    );

                    part_number += 1;
                    transfer.advance(bytes_read_total as u64);
                }

                transfer.checkpoint().await?;

                let completed_upload = CompletedMultipartUpload::builder()
                    .set_parts(Some(completed_parts))
                    .build();

                transfer
                    .guard(async {
                        self.client
                            .complete_multipart_upload()
                            .bucket(&self.bucket)
                            .key(&key)
                            .upload_id(upload_id)
                            .multipart_upload(completed_upload)
                            .send()
                            .await
                            .map_err(|e| {
                                eprintln!(
                                    "[Orbit S3] ❌ complete_multipart failed for key='{}': {}",
                                    key, e
                                );
                                AppError::S3(format!("Erreur de finalisation multipart : {}", e))
                            })
                    })
                    .await?;
                Ok(())
            }
            .await;

            if let Err(err) = upload_result {
                // Libère les parts déjà envoyées (sinon elles restent facturées côté fournisseur).
                let _ = self
                    .client
                    .abort_multipart_upload()
                    .bucket(&self.bucket)
                    .key(&key)
                    .upload_id(upload_id)
                    .send()
                    .await;
                return Err(err);
            }
        } else {
            let data = tokio::fs::read(&local_path)
                .await
                .map_err(|e| AppError::Io(format!("Erreur de lecture du fichier local : {}", e)))?;
            let body = ByteStream::from(data);

            transfer
                .guard(async {
                    self.client
                        .put_object()
                        .bucket(&self.bucket)
                        .key(&key)
                        .content_length(total_bytes as i64)
                        .body(body)
                        .send()
                        .await
                        .map_err(|e| {
                            eprintln!(
                                "[Orbit S3] ❌ put_object failed for key='{}' in bucket='{}': {}",
                                key, self.bucket, e
                            );
                            AppError::S3(format!("Erreur d'envoi vers S3 : {}", e))
                        })
                })
                .await?;
        }

        transfer.complete();
        Ok(())
    }
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
            "\\windows\\path.txt"
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
