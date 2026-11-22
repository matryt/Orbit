use std::net::{Ipv4Addr, Ipv6Addr};
use std::time::Duration;
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};

use crate::error::AppError;
use crate::models::ProxyConfig;

/// Formate une adresse hôte et port, en encadrant les adresses IPv6 littérales de crochets si nécessaire.
pub fn format_host_port(host: &str, port: u16) -> String {
    if host.contains(':') && !host.starts_with('[') && !host.ends_with(']') {
        format!("[{host}]:{port}")
    } else {
        format!("{host}:{port}")
    }
}

/// Encode une chaîne ou séquence d'octets en Base64 standard (RFC 4648).
pub fn base64_encode(input: &[u8]) -> String {
    const TABLE: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::new();
    for chunk in input.chunks(3) {
        let b0 = chunk[0];
        let b1 = if chunk.len() > 1 { chunk[1] } else { 0 };
        let b2 = if chunk.len() > 2 { chunk[2] } else { 0 };

        out.push(TABLE[(b0 >> 2) as usize] as char);
        out.push(TABLE[(((b0 & 0x03) << 4) | (b1 >> 4)) as usize] as char);
        if chunk.len() > 1 {
            out.push(TABLE[(((b1 & 0x0f) << 2) | (b2 >> 6)) as usize] as char);
        } else {
            out.push('=');
        }
        if chunk.len() > 2 {
            out.push(TABLE[(b2 & 0x3f) as usize] as char);
        } else {
            out.push('=');
        }
    }
    out
}

/// Établit une connexion TCP vers un proxy (SOCKS5 ou HTTP CONNECT) et négocie le tunnel vers la cible.
pub async fn connect_via_proxy(
    proxy: &ProxyConfig,
    target_host: &str,
    target_port: u16,
) -> Result<tokio::net::TcpStream, AppError> {
    let proxy_host = proxy
        .host
        .as_deref()
        .filter(|h| !h.trim().is_empty())
        .ok_or_else(|| AppError::Io("Hôte du proxy manquant".into()))?;
    let proxy_type = proxy
        .proxy_type
        .as_deref()
        .unwrap_or("socks5")
        .to_ascii_lowercase();
    let proxy_port = proxy.port.unwrap_or(match proxy_type.as_str() {
        "http" => 8080,
        _ => 1080,
    });

    let proxy_addr = format_host_port(proxy_host, proxy_port);
    let connect_future = tokio::net::TcpStream::connect(&proxy_addr);
    let mut stream = tokio::time::timeout(Duration::from_secs(15), connect_future)
        .await
        .map_err(|_| {
            AppError::Io(format!(
                "Délai d'attente dépassé (15s) lors de la connexion au serveur proxy {proxy_addr}"
            ))
        })?
        .map_err(|e| {
            AppError::Io(format!(
                "Impossible de se connecter au serveur proxy {proxy_addr}: {e}"
            ))
        })?;

    let username = proxy.username.as_deref().filter(|u| !u.trim().is_empty());
    let password = proxy.password.as_deref();

    match proxy_type.as_str() {
        "socks5" => {
            socks5_handshake(&mut stream, username, password, target_host, target_port).await?;
        }
        "http" => {
            http_connect_handshake(&mut stream, username, password, target_host, target_port)
                .await?;
        }
        "https" => {
            return Err(AppError::Io(
                "Les proxys HTTPS (TLS) ne sont pas encore pris en charge. Utilisez 'http' (HTTP CONNECT) ou 'socks5'.".into(),
            ));
        }
        other => {
            return Err(AppError::Io(format!(
                "Type de proxy non pris en charge : '{other}'. Utilisez 'socks5' ou 'http'."
            )));
        }
    }

    Ok(stream)
}

/// Négociation SOCKS5 (RFC 1928 & RFC 1929).
pub async fn socks5_handshake<S: AsyncRead + AsyncWrite + Unpin>(
    stream: &mut S,
    username: Option<&str>,
    password: Option<&str>,
    target_host: &str,
    target_port: u16,
) -> Result<(), AppError> {
    // 1. Initial greeting
    if username.is_some() {
        // Support NO AUTH (0x00) et USER/PASS (0x02)
        stream.write_all(&[0x05, 0x02, 0x00, 0x02]).await?;
    } else {
        // Uniquement NO AUTH (0x00)
        stream.write_all(&[0x05, 0x01, 0x00]).await?;
    }
    stream.flush().await?;

    let mut greeting_resp = [0u8; 2];
    stream.read_exact(&mut greeting_resp).await.map_err(|e| {
        AppError::Io(format!(
            "Erreur de lecture lors de la salutation SOCKS5: {e}"
        ))
    })?;

    if greeting_resp[0] != 0x05 {
        return Err(AppError::Io(format!(
            "Réponse proxy SOCKS5 invalide (version reçue: 0x{:02x}, attendue: 0x05)",
            greeting_resp[0]
        )));
    }

    match greeting_resp[1] {
        0x00 => {
            // Pas d'authentification requise
        }
        0x02 => {
            // Authentification Username / Password (RFC 1929)
            if username.is_none() {
                return Err(AppError::Auth(
                    "Le serveur proxy SOCKS5 a sélectionné l'authentification par identifiants alors qu'aucun utilisateur n'a été configuré".into(),
                ));
            }
            let user = username.unwrap_or_default();
            let pass = password.unwrap_or_default();
            if user.is_empty() {
                return Err(AppError::Auth("Nom d'utilisateur SOCKS5 manquant".into()));
            }
            if user.len() > 255 || pass.len() > 255 {
                return Err(AppError::Auth(
                    "Identifiants de proxy SOCKS5 trop longs (max 255 caractères)".into(),
                ));
            }

            let mut auth_req = Vec::with_capacity(3 + user.len() + pass.len());
            auth_req.push(0x01); // Auth subnegotiation version
            auth_req.push(user.len() as u8);
            auth_req.extend_from_slice(user.as_bytes());
            auth_req.push(pass.len() as u8);
            auth_req.extend_from_slice(pass.as_bytes());

            stream.write_all(&auth_req).await?;
            stream.flush().await?;

            let mut auth_resp = [0u8; 2];
            stream.read_exact(&mut auth_resp).await.map_err(|e| {
                AppError::Auth(format!("Erreur de réponse d'authentification SOCKS5: {e}"))
            })?;

            if auth_resp[0] != 0x01 || auth_resp[1] != 0x00 {
                return Err(AppError::Auth(
                    "Authentification refusée par le serveur proxy SOCKS5".into(),
                ));
            }
        }
        0xFF => {
            return Err(AppError::Auth(
                "Le serveur proxy SOCKS5 ne propose aucune méthode d'authentification compatible"
                    .into(),
            ));
        }
        other => {
            return Err(AppError::Auth(format!(
                "Méthode d'authentification SOCKS5 non supportée (code 0x{other:02x})"
            )));
        }
    }

    // 2. Request CONNECT
    let mut req = Vec::new();
    req.push(0x05); // Version
    req.push(0x01); // CMD: CONNECT
    req.push(0x00); // Reserved

    if let Ok(ipv4) = target_host.parse::<Ipv4Addr>() {
        req.push(0x01); // IPv4
        req.extend_from_slice(&ipv4.octets());
    } else if let Ok(ipv6) = target_host.parse::<Ipv6Addr>() {
        req.push(0x04); // IPv6
        req.extend_from_slice(&ipv6.octets());
    } else {
        // Nom de domaine (résolu par le proxy)
        if target_host.len() > 255 {
            return Err(AppError::Io(
                "Nom d'hôte cible trop long pour SOCKS5 (max 255 caractères)".into(),
            ));
        }
        req.push(0x03); // Domain name
        req.push(target_host.len() as u8);
        req.extend_from_slice(target_host.as_bytes());
    }

    req.extend_from_slice(&target_port.to_be_bytes());
    stream.write_all(&req).await?;
    stream.flush().await?;

    // 3. Response
    let mut resp_header = [0u8; 4];
    stream.read_exact(&mut resp_header).await.map_err(|e| {
        AppError::Io(format!(
            "Erreur de lecture de la réponse CONNECT du proxy SOCKS5: {e}"
        ))
    })?;

    if resp_header[0] != 0x05 {
        return Err(AppError::Io(format!(
            "Réponse CONNECT SOCKS5 invalide (version 0x{:02x})",
            resp_header[0]
        )));
    }

    if resp_header[1] != 0x00 {
        let reason = match resp_header[1] {
            0x01 => "Échec général du serveur proxy",
            0x02 => "Connexion non autorisée par les règles du proxy",
            0x03 => "Réseau inaccessible",
            0x04 => "Hôte cible inaccessible",
            0x05 => "Connexion refusée par l'hôte cible",
            0x06 => "Délai d'attente (TTL) expiré",
            0x07 => "Commande SOCKS5 non supportée",
            0x08 => "Type d'adresse non supporté",
            code => return Err(AppError::Io(format!("Erreur proxy SOCKS5 (code {code})"))),
        };
        return Err(AppError::Io(format!(
            "Le proxy SOCKS5 a rejeté la connexion vers {target_host}:{target_port} : {reason}"
        )));
    }

    // Lire l'adresse et le port liés (bound address) pour vider la réponse
    match resp_header[3] {
        0x01 => {
            // IPv4 : 4 octets + 2 octets port
            let mut buf = [0u8; 6];
            stream.read_exact(&mut buf).await?;
        }
        0x04 => {
            // IPv6 : 16 octets + 2 octets port
            let mut buf = [0u8; 18];
            stream.read_exact(&mut buf).await?;
        }
        0x03 => {
            // Domain : 1 octet len + domain + 2 octets port
            let mut len_buf = [0u8; 1];
            stream.read_exact(&mut len_buf).await?;
            let domain_len = len_buf[0] as usize;
            let mut rest = vec![0u8; domain_len + 2];
            stream.read_exact(&mut rest).await?;
        }
        atyp => {
            return Err(AppError::Io(format!(
                "Type d'adresse SOCKS5 non pris en charge dans la réponse : 0x{atyp:02x}"
            )));
        }
    }

    Ok(())
}

/// Négociation HTTP CONNECT (tunnel transparent).
pub async fn http_connect_handshake<S: AsyncRead + AsyncWrite + Unpin>(
    stream: &mut S,
    username: Option<&str>,
    password: Option<&str>,
    target_host: &str,
    target_port: u16,
) -> Result<(), AppError> {
    if target_host
        .chars()
        .any(|c| c == '\r' || c == '\n' || c == ' ')
    {
        return Err(AppError::Io(
            "Hôte cible invalide pour la requête HTTP CONNECT (caractères interdits)".into(),
        ));
    }
    if let Some(user) = username {
        if user.chars().any(|c| c == '\r' || c == '\n') {
            return Err(AppError::Io(
                "Nom d'utilisateur proxy invalide (caractères de saut de ligne interdits)".into(),
            ));
        }
    }
    if let Some(pass) = password {
        if pass.chars().any(|c| c == '\r' || c == '\n') {
            return Err(AppError::Io(
                "Mot de passe proxy invalide (caractères de saut de ligne interdits)".into(),
            ));
        }
    }

    let host_authority = format_host_port(target_host, target_port);
    let mut request = format!(
        "CONNECT {host_authority} HTTP/1.1\r\nHost: {host_authority}\r\nProxy-Connection: Keep-Alive\r\n"
    );

    if let Some(user) = username {
        let pass = password.unwrap_or_default();
        let raw_creds = format!("{user}:{pass}");
        let encoded = base64_encode(raw_creds.as_bytes());
        request.push_str(&format!("Proxy-Authorization: Basic {encoded}\r\n"));
    }

    request.push_str("\r\n");

    stream.write_all(request.as_bytes()).await?;
    stream.flush().await?;

    // Lecture de la réponse HTTP (boucle pour ignorer d'éventuelles réponses d'information 1xx)
    loop {
        let mut response_buf = Vec::new();
        let mut byte = [0u8; 1];
        let max_header_len = 8192;

        while response_buf.len() < max_header_len {
            stream.read_exact(&mut byte).await.map_err(|e| {
                AppError::Io(format!(
                    "Erreur de lecture lors de la réponse HTTP CONNECT: {e}"
                ))
            })?;
            response_buf.push(byte[0]);

            if response_buf.ends_with(b"\r\n\r\n") {
                break;
            }
        }

        if !response_buf.ends_with(b"\r\n\r\n") {
            return Err(AppError::Io(
                "En-tête de réponse HTTP du proxy trop volumineux ou incomplet (dépasse 8 KiB sans CRLF final)".into(),
            ));
        }

        let response_str = String::from_utf8_lossy(&response_buf);
        let first_line = response_str
            .lines()
            .next()
            .ok_or_else(|| AppError::Io("Réponse HTTP vide du proxy".into()))?;

        // Ex: "HTTP/1.1 200 Connection established"
        let parts: Vec<&str> = first_line.split_whitespace().collect();
        if parts.len() < 2 {
            return Err(AppError::Io(format!(
                "Réponse HTTP du proxy malformée : '{first_line}'"
            )));
        }

        let status_code: u16 = parts[1].parse().map_err(|_| {
            AppError::Io(format!(
                "Code statut HTTP invalide dans la réponse du proxy : '{first_line}'"
            ))
        })?;

        // 1xx Informational (ex: 103 Early Hints, 100 Continue) : ignorer et lire la réponse finale
        if (100..=199).contains(&status_code) {
            continue;
        }

        if status_code == 407 {
            return Err(AppError::Auth(
                "Authentification proxy HTTP requise (407 Proxy Authentication Required). Vérifiez les identifiants du proxy.".into(),
            ));
        }

        if !(200..=299).contains(&status_code) {
            return Err(AppError::Io(format!(
                "Le proxy HTTP a rejeté la requête CONNECT vers {target_host}:{target_port} ({first_line})"
            )));
        }

        break;
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::io::duplex;

    #[test]
    fn test_base64_encode() {
        assert_eq!(base64_encode(b""), "");
        assert_eq!(base64_encode(b"f"), "Zg==");
        assert_eq!(base64_encode(b"fo"), "Zm8=");
        assert_eq!(base64_encode(b"foo"), "Zm9v");
        assert_eq!(base64_encode(b"user:pass123"), "dXNlcjpwYXNzMTIz");
    }

    #[tokio::test]
    async fn test_socks5_handshake_no_auth_success() {
        let (mut client, mut server) = duplex(1024);

        let server_task = tokio::spawn(async move {
            let mut greeting = [0u8; 3];
            server.read_exact(&mut greeting).await.unwrap();
            assert_eq!(greeting, [0x05, 0x01, 0x00]);

            // Server selects NO AUTH
            server.write_all(&[0x05, 0x00]).await.unwrap();

            // Read CONNECT request for domain
            let mut req_header = [0u8; 4];
            server.read_exact(&mut req_header).await.unwrap();
            assert_eq!(req_header[0], 0x05); // ver
            assert_eq!(req_header[1], 0x01); // cmd: connect
            assert_eq!(req_header[3], 0x03); // domain

            let mut dlen = [0u8; 1];
            server.read_exact(&mut dlen).await.unwrap();
            let mut domain = vec![0u8; dlen[0] as usize];
            server.read_exact(&mut domain).await.unwrap();
            assert_eq!(domain, b"target.lan");

            let mut port = [0u8; 2];
            server.read_exact(&mut port).await.unwrap();
            assert_eq!(u16::from_be_bytes(port), 22);

            // Server responds success
            server
                .write_all(&[0x05, 0x00, 0x00, 0x01, 127, 0, 0, 1, 0, 22])
                .await
                .unwrap();
        });

        let client_task = tokio::spawn(async move {
            socks5_handshake(&mut client, None, None, "target.lan", 22)
                .await
                .unwrap();
        });

        let (s_res, c_res) = tokio::join!(server_task, client_task);
        s_res.unwrap();
        c_res.unwrap();
    }

    #[tokio::test]
    async fn test_socks5_handshake_user_pass_success() {
        let (mut client, mut server) = duplex(1024);

        let server_task = tokio::spawn(async move {
            let mut greeting = [0u8; 4];
            server.read_exact(&mut greeting).await.unwrap();
            assert_eq!(greeting, [0x05, 0x02, 0x00, 0x02]);

            // Server selects USER/PASS (0x02)
            server.write_all(&[0x05, 0x02]).await.unwrap();

            // Read auth subnegotiation
            let mut auth_ver = [0u8; 1];
            server.read_exact(&mut auth_ver).await.unwrap();
            assert_eq!(auth_ver[0], 0x01);

            let mut ulen = [0u8; 1];
            server.read_exact(&mut ulen).await.unwrap();
            let mut user = vec![0u8; ulen[0] as usize];
            server.read_exact(&mut user).await.unwrap();
            assert_eq!(user, b"alice");

            let mut plen = [0u8; 1];
            server.read_exact(&mut plen).await.unwrap();
            let mut pass = vec![0u8; plen[0] as usize];
            server.read_exact(&mut pass).await.unwrap();
            assert_eq!(pass, b"secret");

            // Auth success
            server.write_all(&[0x01, 0x00]).await.unwrap();

            // Read CONNECT IPv4
            let mut req = [0u8; 10];
            server.read_exact(&mut req).await.unwrap();
            assert_eq!(&req[0..4], &[0x05, 0x01, 0x00, 0x01]);
            assert_eq!(&req[4..8], &[192, 168, 1, 50]);
            assert_eq!(&req[8..10], &2222u16.to_be_bytes());

            // Reply success
            server
                .write_all(&[0x05, 0x00, 0x00, 0x01, 0, 0, 0, 0, 0, 0])
                .await
                .unwrap();
        });

        let client_task = tokio::spawn(async move {
            socks5_handshake(
                &mut client,
                Some("alice"),
                Some("secret"),
                "192.168.1.50",
                2222,
            )
            .await
            .unwrap();
        });

        let (s_res, c_res) = tokio::join!(server_task, client_task);
        s_res.unwrap();
        c_res.unwrap();
    }

    #[tokio::test]
    async fn test_socks5_handshake_rejected() {
        let (mut client, mut server) = duplex(1024);

        let server_task = tokio::spawn(async move {
            let mut greeting = [0u8; 3];
            server.read_exact(&mut greeting).await.unwrap();
            server.write_all(&[0x05, 0x00]).await.unwrap();

            let mut req = [0u8; 10];
            server.read_exact(&mut req).await.unwrap();
            // Server replies 0x05: Connection refused
            server
                .write_all(&[0x05, 0x05, 0x00, 0x01, 0, 0, 0, 0, 0, 0])
                .await
                .unwrap();
        });

        let client_task = tokio::spawn(async move {
            let err = socks5_handshake(&mut client, None, None, "10.0.0.1", 22)
                .await
                .unwrap_err();
            assert!(err.to_string().contains("Connexion refusée"));
        });

        let (s_res, c_res) = tokio::join!(server_task, client_task);
        s_res.unwrap();
        c_res.unwrap();
    }

    #[tokio::test]
    async fn test_http_connect_success() {
        let (mut client, mut server) = duplex(1024);

        let server_task = tokio::spawn(async move {
            let mut req_bytes = Vec::new();
            let mut byte = [0u8; 1];
            while !req_bytes.ends_with(b"\r\n\r\n") {
                server.read_exact(&mut byte).await.unwrap();
                req_bytes.push(byte[0]);
            }
            let req_str = String::from_utf8(req_bytes).unwrap();
            assert!(req_str.starts_with("CONNECT target.lan:22 HTTP/1.1\r\n"));
            assert!(req_str.contains("Proxy-Authorization: Basic YWRtaW46cGFzczQ1Ng=="));

            server
                .write_all(b"HTTP/1.1 200 Connection established\r\n\r\n")
                .await
                .unwrap();
        });

        let client_task = tokio::spawn(async move {
            http_connect_handshake(
                &mut client,
                Some("admin"),
                Some("pass456"),
                "target.lan",
                22,
            )
            .await
            .unwrap();
        });

        let (s_res, c_res) = tokio::join!(server_task, client_task);
        s_res.unwrap();
        c_res.unwrap();
    }

    #[tokio::test]
    async fn test_http_connect_auth_required_407() {
        let (mut client, mut server) = duplex(1024);

        let server_task = tokio::spawn(async move {
            let mut req_bytes = Vec::new();
            let mut byte = [0u8; 1];
            while !req_bytes.ends_with(b"\r\n\r\n") {
                server.read_exact(&mut byte).await.unwrap();
                req_bytes.push(byte[0]);
            }
            server
                .write_all(b"HTTP/1.1 407 Proxy Authentication Required\r\n\r\n")
                .await
                .unwrap();
        });

        let client_task = tokio::spawn(async move {
            let err = http_connect_handshake(&mut client, None, None, "target.lan", 22)
                .await
                .unwrap_err();
            assert!(err.to_string().contains("407"));
        });

        let (s_res, c_res) = tokio::join!(server_task, client_task);
        s_res.unwrap();
        c_res.unwrap();
    }
}
