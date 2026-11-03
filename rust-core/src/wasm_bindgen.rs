use std::cell::RefCell;

use serde::{Deserialize, Serialize};
use wasm_bindgen::prelude::*;

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ProbeRequest {
    value: String,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ProbeResponse {
    value: String,
    version: u32,
}

#[wasm_bindgen]
pub struct Core {
    version: u32,
    state: RefCell<u32>,
}

#[wasm_bindgen]
impl Core {
    #[wasm_bindgen(constructor)]
    pub fn new() -> Core {
        Core {
            version: crate::CORE_ABI_VERSION,
            state: RefCell::new(0),
        }
    }

    pub fn boundary_version(&self) -> u32 {
        self.version
    }

    pub fn probe(&self, input: JsValue) -> Result<JsValue, JsError> {
        let request: ProbeRequest =
            serde_wasm_bindgen::from_value(input).map_err(|error| JsError::new(&error.to_string()))?;
        let mut state = self.state.borrow_mut();
        *state = state.saturating_add(1);
        serde_wasm_bindgen::to_value(&ProbeResponse {
            value: request.value,
            version: self.version,
        })
        .map_err(|error| JsError::new(&error.to_string()))
    }
}
