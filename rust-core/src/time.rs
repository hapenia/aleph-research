use std::fmt;
use std::str::FromStr;

use crate::error::TimestampError;

const MILLIS_PER_SECOND: i64 = 1_000;
const MILLIS_PER_MINUTE: i64 = 60 * MILLIS_PER_SECOND;
const MILLIS_PER_HOUR: i64 = 60 * MILLIS_PER_MINUTE;
const MILLIS_PER_DAY: i64 = 24 * MILLIS_PER_HOUR;

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct Timestamp(i64);

impl Timestamp {
    pub const UNIX_EPOCH: Self = Self(0);

    pub const fn from_millis(millis: i64) -> Self {
        Self(millis)
    }

    pub const fn as_millis(self) -> i64 {
        self.0
    }

    pub fn checked_add(self, millis: i64) -> Option<Self> {
        self.0.checked_add(millis).map(Self)
    }

    pub fn parse(value: &str) -> Result<Self, TimestampError> {
        let bytes = value.as_bytes();
        if bytes.len() < 20 {
            return Err(TimestampError::InvalidFormat);
        }
        if bytes[4] != b'-'
            || bytes[7] != b'-'
            || bytes[10] != b'T'
            || bytes[13] != b':'
            || bytes[16] != b':'
        {
            return Err(TimestampError::InvalidFormat);
        }
        let year = parse_number(&bytes[0..4])? as i64;
        let month = parse_number(&bytes[5..7])?;
        let day = parse_number(&bytes[8..10])?;
        let hour = parse_number(&bytes[11..13])?;
        let minute = parse_number(&bytes[14..16])?;
        let second = parse_number(&bytes[17..19])?;
        if !(1..=12).contains(&month) || day == 0 || day > days_in_month(year, month) {
            return Err(TimestampError::InvalidDate);
        }
        if hour > 23 || minute > 59 || second > 59 {
            return Err(TimestampError::InvalidDate);
        }
        let mut index = 19;
        let mut millis = 0i64;
        if bytes.get(index) == Some(&b'.') {
            index += 1;
            let start = index;
            while index < bytes.len() && bytes[index].is_ascii_digit() {
                index += 1;
            }
            let digits = index - start;
            if digits == 0 || digits > 9 {
                return Err(TimestampError::InvalidFormat);
            }
            for position in 0..3 {
                let digit = if position < digits {
                    i64::from(bytes[start + position] - b'0')
                } else {
                    0
                };
                millis = millis * 10 + digit;
            }
        }
        if bytes.get(index) != Some(&b'Z') || index + 1 != bytes.len() {
            return Err(TimestampError::InvalidFormat);
        }
        let days = days_from_civil(year, month, day);
        let seconds = days
            .checked_mul(86_400)
            .and_then(|value| value.checked_add(i64::from(hour) * 3_600))
            .and_then(|value| value.checked_add(i64::from(minute) * 60))
            .and_then(|value| value.checked_add(i64::from(second)))
            .ok_or(TimestampError::OutOfRange)?;
        seconds
            .checked_mul(MILLIS_PER_SECOND)
            .and_then(|value| value.checked_add(millis))
            .map(Self)
            .ok_or(TimestampError::OutOfRange)
    }
}

impl Default for Timestamp {
    fn default() -> Self {
        Self::UNIX_EPOCH
    }
}

impl fmt::Display for Timestamp {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        let days = self.0.div_euclid(MILLIS_PER_DAY);
        let remainder = self.0.rem_euclid(MILLIS_PER_DAY);
        let (year, month, day) = civil_from_days(days);
        let hour = remainder / MILLIS_PER_HOUR;
        let minute = (remainder % MILLIS_PER_HOUR) / MILLIS_PER_MINUTE;
        let second = (remainder % MILLIS_PER_MINUTE) / MILLIS_PER_SECOND;
        let millis = remainder % MILLIS_PER_SECOND;
        write!(
            formatter,
            "{year:04}-{month:02}-{day:02}T{hour:02}:{minute:02}:{second:02}.{millis:03}Z"
        )
    }
}

impl FromStr for Timestamp {
    type Err = TimestampError;

    fn from_str(value: &str) -> Result<Self, Self::Err> {
        Self::parse(value)
    }
}

fn parse_number(bytes: &[u8]) -> Result<u32, TimestampError> {
    let mut value = 0u32;
    for byte in bytes {
        if !byte.is_ascii_digit() {
            return Err(TimestampError::InvalidFormat);
        }
        value = value * 10 + u32::from(byte - b'0');
    }
    Ok(value)
}

fn is_leap_year(year: i64) -> bool {
    (year % 4 == 0 && year % 100 != 0) || year % 400 == 0
}

fn days_in_month(year: i64, month: u32) -> u32 {
    match month {
        1 | 3 | 5 | 7 | 8 | 10 | 12 => 31,
        4 | 6 | 9 | 11 => 30,
        2 if is_leap_year(year) => 29,
        2 => 28,
        _ => 0,
    }
}

fn days_from_civil(year: i64, month: u32, day: u32) -> i64 {
    let adjusted_year = if month <= 2 { year - 1 } else { year };
    let era = if adjusted_year >= 0 {
        adjusted_year
    } else {
        adjusted_year - 399
    } / 400;
    let year_of_era = adjusted_year - era * 400;
    let month_index = (i64::from(month) + 9) % 12;
    let day_of_year = (153 * month_index + 2) / 5 + i64::from(day) - 1;
    let day_of_era = year_of_era * 365 + year_of_era / 4 - year_of_era / 100 + day_of_year;
    era * 146_097 + day_of_era - 719_468
}

fn civil_from_days(days: i64) -> (i64, u32, u32) {
    let shifted = days + 719_468;
    let era = if shifted >= 0 {
        shifted
    } else {
        shifted - 146_096
    } / 146_097;
    let day_of_era = shifted - era * 146_097;
    let year_of_era =
        (day_of_era - day_of_era / 1_460 + day_of_era / 36_524 - day_of_era / 146_096) / 365;
    let year = year_of_era + era * 400;
    let day_of_year = day_of_era - (365 * year_of_era + year_of_era / 4 - year_of_era / 100);
    let month_index = (5 * day_of_year + 2) / 153;
    let day = day_of_year - (153 * month_index + 2) / 5 + 1;
    let month = if month_index < 10 {
        month_index + 3
    } else {
        month_index - 9
    };
    let civil_year = if month <= 2 { year + 1 } else { year };
    (civil_year, month as u32, day as u32)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_epoch_formats_as_rfc_3339() {
        assert_eq!(
            Timestamp::UNIX_EPOCH.to_string(),
            "1970-01-01T00:00:00.000Z"
        );
        assert_eq!(Timestamp::UNIX_EPOCH.as_millis(), 0);
    }

    #[test]
    fn known_instants_round_trip() {
        let values = [
            ("1970-01-01T00:00:00.000Z", 0),
            ("2000-02-29T12:34:56.789Z", 951_827_696_789),
            ("2024-01-01T00:00:00.000Z", 1_704_067_200_000),
            ("2026-11-02T11:26:39.000Z", 1_793_618_799_000),
        ];
        for (text, millis) in values {
            let timestamp = Timestamp::parse(text).unwrap();
            assert_eq!(timestamp.as_millis(), millis, "{text}");
            assert_eq!(timestamp.to_string(), text);
        }
    }

    #[test]
    fn fractional_seconds_are_padded_and_truncated() {
        assert_eq!(
            Timestamp::parse("1970-01-01T00:00:00.5Z")
                .unwrap()
                .as_millis(),
            500
        );
        assert_eq!(
            Timestamp::parse("1970-01-01T00:00:00.123456789Z")
                .unwrap()
                .as_millis(),
            123
        );
    }

    #[test]
    fn malformed_timestamps_are_rejected() {
        let cases = [
            "1970-01-01 00:00:00Z",
            "1970-01-01T00:00:00",
            "1970-01-01T00:00:00.000",
            "1970-01-01T00:00:00Zjunk",
            "1970-13-01T00:00:00Z",
            "2023-02-29T00:00:00Z",
            "1970-01-01T24:00:00Z",
            "1970-01-01T00:60:00Z",
            "1970-01-01T00:00:60Z",
            "1970-01-01T00:00:00.Z",
        ];
        for value in cases {
            assert!(Timestamp::parse(value).is_err(), "{value}");
        }
    }

    #[test]
    fn leap_days_are_handled() {
        assert_eq!(
            Timestamp::parse("2024-02-29T00:00:00.000Z")
                .unwrap()
                .to_string(),
            "2024-02-29T00:00:00.000Z"
        );
        assert_eq!(
            Timestamp::parse("1900-02-29T00:00:00.000Z").unwrap_err(),
            TimestampError::InvalidDate
        );
    }

    #[test]
    fn arithmetic_is_checked() {
        let timestamp = Timestamp::from_millis(1_000);
        assert_eq!(timestamp.checked_add(500).unwrap().as_millis(), 1_500);
        assert!(Timestamp::from_millis(i64::MAX).checked_add(1).is_none());
    }

    #[test]
    fn timestamps_parse_through_from_str() {
        let timestamp: Timestamp = "1970-01-01T00:00:01.000Z".parse().unwrap();
        assert_eq!(timestamp.as_millis(), 1_000);
    }
}
