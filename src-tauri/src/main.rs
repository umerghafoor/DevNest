#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    if devnest_lib::run_mcp_bridge_if_requested() {
        return;
    }
    devnest_lib::run()
}
