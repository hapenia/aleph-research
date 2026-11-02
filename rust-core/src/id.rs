use std::fmt;
use std::num::{NonZeroU32, NonZeroU64};
use std::str::FromStr;

use crate::error::{IdError, IdReason, NumericError};

const ID_LENGTH: usize = 128;
const NAME_LENGTH: usize = 512;
const COMMIT_LENGTH: usize = 40;
const DIGEST_LENGTH: usize = 64;

fn is_allowed(character: char) -> bool {
    character.is_ascii_alphanumeric() || matches!(character, '-' | '_' | '.' | ':' | '/' | '@')
}

fn validate(value: &str, field: &'static str, max: usize) -> Result<(), IdError> {
    if value.is_empty() {
        return Err(IdError::new(field, IdReason::Empty));
    }
    if value.len() > max {
        return Err(IdError::new(field, IdReason::TooLong { max }));
    }
    if let Some(character) = value.chars().find(|character| !is_allowed(*character)) {
        return Err(IdError::new(
            field,
            IdReason::InvalidCharacter { character },
        ));
    }
    Ok(())
}

macro_rules! id_type {
    ($name:ident, $field:literal, $max:expr) => {
        #[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Hash)]
        pub struct $name(String);

        impl $name {
            pub fn new(value: impl Into<String>) -> Result<Self, IdError> {
                let value = value.into();
                validate(&value, $field, $max)?;
                Ok(Self(value))
            }

            pub fn as_str(&self) -> &str {
                &self.0
            }
        }

        impl fmt::Display for $name {
            fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
                formatter.write_str(&self.0)
            }
        }

        impl FromStr for $name {
            type Err = IdError;

            fn from_str(value: &str) -> Result<Self, Self::Err> {
                Self::new(value)
            }
        }
    };
}

id_type!(ProgramId, "program_id", ID_LENGTH);
id_type!(IssueId, "issue_id", ID_LENGTH);
id_type!(ExperimentId, "experiment_id", ID_LENGTH);
id_type!(TicketId, "ticket_id", ID_LENGTH);
id_type!(BenchmarkRunId, "benchmark_run_id", ID_LENGTH);
id_type!(BenchmarkSpecId, "benchmark_spec_id", ID_LENGTH);
id_type!(ArtifactId, "artifact_id", ID_LENGTH);
id_type!(AuditId, "audit_id", ID_LENGTH);
id_type!(TriggerId, "trigger_id", ID_LENGTH);
id_type!(PipelineRunId, "pipeline_run_id", ID_LENGTH);
id_type!(SessionId, "session_id", ID_LENGTH);
id_type!(ActorId, "actor_id", ID_LENGTH);
id_type!(RequestId, "request_id", ID_LENGTH);
id_type!(CommentId, "comment_id", ID_LENGTH);
id_type!(BranchName, "branch", NAME_LENGTH);
id_type!(EnvironmentFile, "environment_file", NAME_LENGTH);

#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct CommitSha(String);

impl CommitSha {
    pub fn new(value: impl Into<String>) -> Result<Self, IdError> {
        let value = value.into().to_ascii_lowercase();
        if value.len() != COMMIT_LENGTH {
            return Err(IdError::new(
                "commit_sha",
                IdReason::WrongLength {
                    expected: COMMIT_LENGTH,
                    actual: value.len(),
                },
            ));
        }
        if let Some(character) = value
            .chars()
            .find(|character| !character.is_ascii_hexdigit())
        {
            return Err(IdError::new("commit_sha", IdReason::NotHex { character }));
        }
        Ok(Self(value))
    }

    pub fn zero() -> Self {
        Self("0".repeat(COMMIT_LENGTH))
    }

    pub fn is_zero(&self) -> bool {
        self.0.chars().all(|character| character == '0')
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl Default for CommitSha {
    fn default() -> Self {
        Self::zero()
    }
}

impl fmt::Display for CommitSha {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(&self.0)
    }
}

impl FromStr for CommitSha {
    type Err = IdError;

    fn from_str(value: &str) -> Result<Self, Self::Err> {
        Self::new(value)
    }
}

macro_rules! digest_type {
    ($name:ident, $field:literal) => {
        #[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Hash)]
        pub struct $name(String);

        impl $name {
            pub fn new(value: impl Into<String>) -> Result<Self, IdError> {
                let value = value.into().to_ascii_lowercase();
                if value.len() != DIGEST_LENGTH {
                    return Err(IdError::new(
                        $field,
                        IdReason::WrongLength {
                            expected: DIGEST_LENGTH,
                            actual: value.len(),
                        },
                    ));
                }
                if let Some(character) = value
                    .chars()
                    .find(|character| !character.is_ascii_hexdigit())
                {
                    return Err(IdError::new($field, IdReason::NotHex { character }));
                }
                Ok(Self(value))
            }

            pub fn as_str(&self) -> &str {
                &self.0
            }
        }

        impl Default for $name {
            fn default() -> Self {
                Self("0".repeat(DIGEST_LENGTH))
            }
        }

        impl fmt::Display for $name {
            fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
                formatter.write_str(&self.0)
            }
        }

        impl FromStr for $name {
            type Err = IdError;

            fn from_str(value: &str) -> Result<Self, Self::Err> {
                Self::new(value)
            }
        }
    };
}

digest_type!(SpecHash, "spec_hash");
digest_type!(EnvironmentDigest, "environment_digest");

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct Version(NonZeroU64);

impl Version {
    pub fn new(value: u64) -> Result<Self, NumericError> {
        NonZeroU64::new(value)
            .map(Self)
            .ok_or(NumericError::Zero { field: "version" })
    }

    pub fn first() -> Self {
        Self(NonZeroU64::new(1).expect("one is a non-zero version"))
    }

    pub fn get(self) -> u64 {
        self.0.get()
    }

    pub fn next(self) -> Result<Self, NumericError> {
        self.0
            .get()
            .checked_add(1)
            .and_then(NonZeroU64::new)
            .map(Self)
            .ok_or(NumericError::Overflow { field: "version" })
    }
}

impl fmt::Display for Version {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        self.0.fmt(formatter)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct Attempt(NonZeroU32);

impl Attempt {
    pub fn new(value: u32) -> Result<Self, NumericError> {
        NonZeroU32::new(value)
            .map(Self)
            .ok_or(NumericError::Zero { field: "attempt" })
    }

    pub fn first() -> Self {
        Self(NonZeroU32::new(1).expect("one is a non-zero attempt"))
    }

    pub fn get(self) -> u32 {
        self.0.get()
    }

    pub fn next(self) -> Result<Self, NumericError> {
        self.0
            .get()
            .checked_add(1)
            .and_then(NonZeroU32::new)
            .map(Self)
            .ok_or(NumericError::Overflow { field: "attempt" })
    }
}

impl fmt::Display for Attempt {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        self.0.fmt(formatter)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn identifiers_accept_documented_characters() {
        assert!(ProgramId::new("program-1").is_ok());
        assert!(ExperimentId::new("experiment/1:alpha").is_ok());
        assert!(ActorId::new("actor@example").is_ok());
        assert!(RequestId::new("request_1").is_ok());
    }

    #[test]
    fn empty_identifiers_are_rejected() {
        assert_eq!(ProgramId::new("").unwrap_err().reason(), &IdReason::Empty);
    }

    #[test]
    fn oversized_identifiers_are_rejected() {
        let value = "a".repeat(ID_LENGTH + 1);
        assert_eq!(
            IssueId::new(value).unwrap_err().reason(),
            &IdReason::TooLong { max: ID_LENGTH }
        );
    }

    #[test]
    fn invalid_identifier_characters_are_rejected() {
        let error = ExperimentId::new("experiment 1").unwrap_err();
        assert_eq!(
            error.reason(),
            &IdReason::InvalidCharacter { character: ' ' }
        );
        assert_eq!(error.field(), "experiment_id");
    }

    #[test]
    fn identifiers_round_trip_through_display_and_from_str() {
        let id: TicketId = "ticket-9".parse().unwrap();
        assert_eq!(id.as_str(), "ticket-9");
        assert_eq!(id.to_string(), "ticket-9");
    }

    #[test]
    fn commit_shas_are_normalised_to_lowercase() {
        let sha = CommitSha::new("A".repeat(40)).unwrap();
        assert_eq!(sha.as_str(), "a".repeat(40));
        assert!(!sha.is_zero());
    }

    #[test]
    fn the_zero_commit_sha_is_accepted_and_detected() {
        let sha = CommitSha::zero();
        assert!(sha.is_zero());
        assert_eq!(sha.as_str().len(), COMMIT_LENGTH);
        assert_eq!(CommitSha::default(), sha);
    }

    #[test]
    fn short_commit_shas_are_rejected() {
        let error = CommitSha::new("abc").unwrap_err();
        assert_eq!(
            error.reason(),
            &IdReason::WrongLength {
                expected: COMMIT_LENGTH,
                actual: 3
            }
        );
    }

    #[test]
    fn non_hex_commit_shas_are_rejected() {
        let value = format!("{}z", "a".repeat(39));
        assert_eq!(
            CommitSha::new(value).unwrap_err().reason(),
            &IdReason::NotHex { character: 'z' }
        );
    }

    #[test]
    fn digests_require_sixty_four_hex_characters() {
        let digest = SpecHash::new("f".repeat(64)).unwrap();
        assert_eq!(digest.as_str(), "f".repeat(64));
        assert_eq!(
            SpecHash::new("f".repeat(63)).unwrap_err().reason(),
            &IdReason::WrongLength {
                expected: DIGEST_LENGTH,
                actual: 63
            }
        );
        assert_eq!(SpecHash::default().as_str(), "0".repeat(64));
        assert_eq!(
            EnvironmentDigest::new("g".repeat(64)).unwrap_err().reason(),
            &IdReason::NotHex { character: 'g' }
        );
    }

    #[test]
    fn versions_are_non_zero_and_monotonic() {
        assert_eq!(Version::first().get(), 1);
        assert_eq!(Version::first().next().unwrap().get(), 2);
        assert_eq!(
            Version::new(0).unwrap_err(),
            NumericError::Zero { field: "version" }
        );
    }

    #[test]
    fn attempts_are_non_zero_and_monotonic() {
        assert_eq!(Attempt::first().get(), 1);
        assert_eq!(Attempt::first().next().unwrap().get(), 2);
        assert_eq!(
            Attempt::new(0).unwrap_err(),
            NumericError::Zero { field: "attempt" }
        );
    }
}
