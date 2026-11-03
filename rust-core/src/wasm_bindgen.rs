use std::cell::RefCell;
use std::rc::Rc;

use serde::Serialize;
use serde::de::DeserializeOwned;
use wasm_bindgen::prelude::*;

use crate::bridge::{self, CoreState};
use crate::dto::{CoreCommandEffectResume, CoreCommandRequest, CoreEffectResume, CoreStartRequest};

fn decode<T: DeserializeOwned>(input: JsValue) -> Option<T> {
    serde_wasm_bindgen::from_value(input).ok()
}

fn encode<T: Serialize>(frame: &T) -> Result<JsValue, JsError> {
    frame
        .serialize(&serde_wasm_bindgen::Serializer::json_compatible())
        .map_err(|error| JsError::new(&error.to_string()))
}

#[wasm_bindgen]
pub struct Core {
    state: Rc<RefCell<CoreState>>,
}

#[wasm_bindgen]
impl Core {
    #[wasm_bindgen(constructor)]
    pub fn new() -> Core {
        Core {
            state: Rc::new(RefCell::new(CoreState::new())),
        }
    }

    pub fn boundary_version(&self) -> u32 {
        crate::CORE_ABI_VERSION
    }

    pub fn start(&self, input: JsValue) -> Result<JsValue, JsError> {
        let frame = match decode::<CoreStartRequest>(input) {
            Some(request) => bridge::start(&self.state, request),
            None => bridge::protocol_frame("the start request is malformed"),
        };
        encode(&frame)
    }

    pub fn resume(&self, input: JsValue) -> Result<JsValue, JsError> {
        let frame = match decode::<CoreEffectResume>(input) {
            Some(request) => bridge::resume(&self.state, request),
            None => bridge::protocol_frame("the resume request is malformed"),
        };
        encode(&frame)
    }

    pub fn command_start(&self, input: JsValue) -> Result<JsValue, JsError> {
        let frame = match decode::<CoreCommandRequest>(input) {
            Some(request) => bridge::start_command(&self.state, request),
            None => bridge::command_protocol_frame("the command request is malformed"),
        };
        encode(&frame)
    }

    pub fn command_resume(&self, input: JsValue) -> Result<JsValue, JsError> {
        let frame = match decode::<CoreCommandEffectResume>(input) {
            Some(request) => bridge::resume_command(&self.state, request),
            None => bridge::command_protocol_frame("the resume request is malformed"),
        };
        encode(&frame)
    }
}

impl Default for Core {
    fn default() -> Self {
        Self::new()
    }
}
