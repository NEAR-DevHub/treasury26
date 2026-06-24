#[derive(Debug, Clone)]
pub struct AdminCredential {
    pub username: String,
    pub password: String,
}

/// Parse `ADMIN_USERS` (`user:pass,user2:pass2`; password may contain `:`).
pub fn parse_admin_users(admin_users: Option<&str>) -> Vec<AdminCredential> {
    let mut users = Vec::new();

    let Some(raw) = admin_users.filter(|s| !s.trim().is_empty()) else {
        return users;
    };

    for entry in raw.split(',') {
        let entry = entry.trim();
        if entry.is_empty() {
            continue;
        }
        let Some((username, password)) = entry.split_once(':') else {
            continue;
        };
        let username = username.trim();
        let password = password.trim();
        if username.is_empty() || password.is_empty() {
            continue;
        }
        users.push(AdminCredential {
            username: username.to_string(),
            password: password.to_string(),
        });
    }

    users
}

fn constant_time_eq(left: &str, right: &str) -> bool {
    if left.len() != right.len() {
        return false;
    }

    left.bytes()
        .zip(right.bytes())
        .fold(0u8, |acc, (a, b)| acc | (a ^ b))
        == 0
}

pub fn authenticate_admin(
    users: &[AdminCredential],
    username: &str,
    password: &str,
) -> Option<String> {
    for cred in users {
        if constant_time_eq(&cred.username, username) {
            return constant_time_eq(&cred.password, password).then(|| cred.username.clone());
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_admin_users_supports_multiple_entries() {
        let users = parse_admin_users(Some("alice:secret1,bob:pass:with:colons"));
        assert_eq!(users.len(), 2);
        assert_eq!(users[0].username, "alice");
        assert_eq!(users[1].username, "bob");
        assert_eq!(users[1].password, "pass:with:colons");
    }

    #[test]
    fn parse_admin_users_returns_empty_when_unset() {
        assert!(parse_admin_users(None).is_empty());
        assert!(parse_admin_users(Some("")).is_empty());
    }

    #[test]
    fn authenticate_admin_matches_configured_user() {
        let users = parse_admin_users(Some("ops:pw1,megha:pw2"));
        assert_eq!(
            authenticate_admin(&users, "megha", "pw2").as_deref(),
            Some("megha")
        );
        assert!(authenticate_admin(&users, "megha", "wrong").is_none());
    }
}
