use base64::{Engine, prelude::BASE64_STANDARD};
use serde::{Deserialize, Deserializer, Serialize, Serializer};
use serde_with::{DeserializeAs, SerializeAs};
use std::marker::PhantomData;

pub struct Base64Json<T>(PhantomData<Option<T>>);

impl<T> SerializeAs<Option<T>> for Base64Json<T>
where
    T: Serialize,
{
    fn serialize_as<S>(source: &Option<T>, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        let json = serde_json::to_vec(source).map_err(serde::ser::Error::custom)?;
        let encoded = BASE64_STANDARD.encode(json);
        serializer.serialize_str(&encoded)
    }
}

impl<'de, T> DeserializeAs<'de, Option<T>> for Base64Json<T>
where
    T: for<'a> Deserialize<'a>,
{
    fn deserialize_as<D>(deserializer: D) -> Result<Option<T>, D::Error>
    where
        D: Deserializer<'de>,
    {
        let encoded: String = Deserialize::deserialize(deserializer)?;
        if encoded.is_empty() {
            return Ok(None);
        }
        let deserialized_bytes = BASE64_STANDARD
            .decode(&encoded)
            .map_err(serde::de::Error::custom)?;
        serde_json::from_slice(&deserialized_bytes).map_err(serde::de::Error::custom)
    }
}
