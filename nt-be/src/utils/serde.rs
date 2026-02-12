use serde::{Deserialize, Deserializer};

/// Deserializer for comma-separated values
/// Accepts either a comma-separated string or None
///
/// # Example
/// ```
/// use serde::Deserialize;
///
/// #[derive(Deserialize)]
/// struct MyStruct {
///     #[serde(default, deserialize_with = "crate::utils::serde::comma_separated")]
///     pub items: Option<Vec<String>>,
/// }
/// ```
pub fn comma_separated<'de, D>(deserializer: D) -> Result<Option<Vec<String>>, D::Error>
where
    D: Deserializer<'de>,
{
    let s: Option<String> = Option::deserialize(deserializer)?;
    Ok(s.map(|s| {
        s.split(',')
            .map(|item| item.trim().to_string())
            .filter(|item| !item.is_empty())
            .collect()
    }))
}
