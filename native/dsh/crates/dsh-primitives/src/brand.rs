//! Compile-time brand for otherwise identical string ids.
//!
//! Matches `@deepseek-ai/dsh-brand`: a `SessionId` cannot be passed where a
//! `CallId` is expected. Construction stays in the owning crate.

use std::fmt;
use std::marker::PhantomData;

/// Marker type that names a brand.
pub trait Brand {
    /// Stable brand label used in diagnostics.
    const NAME: &'static str;
}

/// A string carrying compile-time brand `B`.
#[derive(Clone, Debug, Eq, Hash, Ord, PartialEq, PartialOrd)]
pub struct Branded<B> {
    value: String,
    _brand: PhantomData<B>,
}

impl<B: Brand> Branded<B> {
    /// Wrap an owned string as this brand.
    pub fn new(value: impl Into<String>) -> Self {
        Self {
            value: value.into(),
            _brand: PhantomData,
        }
    }

    /// Borrow the underlying string.
    pub fn as_str(&self) -> &str {
        &self.value
    }

    /// Consume the wrapper and return the string.
    pub fn into_inner(self) -> String {
        self.value
    }
}

impl<B: Brand> fmt::Display for Branded<B> {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.value)
    }
}

impl<B: Brand> AsRef<str> for Branded<B> {
    fn as_ref(&self) -> &str {
        self.as_str()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[derive(Clone, Copy, Debug, Eq, Hash, Ord, PartialEq, PartialOrd)]
    struct SessionBrand;
    impl Brand for SessionBrand {
        const NAME: &'static str = "SessionId";
    }
    type SessionId = Branded<SessionBrand>;

    #[test]
    fn branded_strings_keep_their_value() {
        let session = SessionId::new("sess-1");
        assert_eq!(session.as_str(), "sess-1");
        assert_eq!(session.to_string(), "sess-1");
        assert_eq!(SessionBrand::NAME, "SessionId");
    }
}
