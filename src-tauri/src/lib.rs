mod ai;
mod blitz;
mod clipboard;
mod db;
mod fs;
mod history;
mod index;
mod js;
mod lsp;
mod mago;
mod mcp;
mod process;
mod project;
mod pty;
mod search;
mod spell;
mod trust;
mod watcher;
mod xdebug;

use tauri::Manager;

/// macOS: the app's menu, without the default one's File ▸ Close Window: its Cmd+W would close the
/// whole window, where keymaps use Cmd+W to close a tab (the keymap runs in the page). Quit, Hide and
/// Minimize keep their usual keys; Edit keeps copy and paste working in text fields.
#[cfg(target_os = "macos")]
fn mac_menu(app: &tauri::AppHandle) -> tauri::Result<tauri::menu::Menu<tauri::Wry>> {
    use tauri::menu::{Menu, PredefinedMenuItem as Item, Submenu};
    let app_menu = Submenu::with_items(
        app,
        "PHPBlitz",
        true,
        &[
            &Item::about(app, None, None)?,
            &Item::separator(app)?,
            &Item::services(app, None)?,
            &Item::separator(app)?,
            &Item::hide(app, None)?,
            &Item::hide_others(app, None)?,
            &Item::show_all(app, None)?,
            &Item::separator(app)?,
            &Item::quit(app, None)?,
        ],
    )?;
    let edit = Submenu::with_items(
        app,
        "Edit",
        true,
        &[
            &Item::undo(app, None)?,
            &Item::redo(app, None)?,
            &Item::separator(app)?,
            &Item::cut(app, None)?,
            &Item::copy(app, None)?,
            &Item::paste(app, None)?,
            &Item::select_all(app, None)?,
        ],
    )?;
    let window = Submenu::with_items(app, "Window", true, &[&Item::minimize(app, None)?, &Item::maximize(app, None)?])?;
    Menu::with_items(app, &[&app_menu, &edit, &window])
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let builder = tauri::Builder::default();
    #[cfg(target_os = "macos")]
    let builder = builder.menu(mac_menu);
    builder
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .manage(lsp::LspState::default())
        .manage(process::JobState::default())
        .manage(mago::MagoState::default())
        .manage(index::IndexState::default())
        .manage(watcher::WatchState::default())
        .manage(pty::PtyState::default())
        .manage(db::DbState::default())
        .manage(xdebug::XdebugState::default())
        .manage(mcp::McpState::default())
        .manage(ai::AiState::default())
        .invoke_handler(tauri::generate_handler![
            clipboard::clipboard_read_text,
            ai::ai_key_status,
            ai::ai_set_key,
            ai::ai_stream,
            ai::ai_cancel,
            ai::ai_models,
            mcp::mcp_start,
            mcp::mcp_stop,
            mcp::mcp_status,
            mcp::mcp_new_token,
            mcp::mcp_agent_config,
            fs::list_dir,
            fs::list_files,
            fs::read_file,
            fs::read_binary,
            trust::trust_restrict,
            fs::write_file,
            fs::create_file,
            fs::create_dir,
            fs::rename_path,
            fs::copy_path,
            fs::delete_to_trash,
            fs::is_readonly,
            fs::set_readonly,
            process::run_process,
            process::run_shell,
            process::find_executable,
            process::reveal_in_explorer,
            process::open_external,
            process::updater_supported,
            process::job_run,
            process::job_exec,
            process::job_kill,
            lsp::lsp_start,
            lsp::lsp_send,
            lsp::lsp_stop,
            index::index_open,
            index::index_update,
            index::index_update_text,
            index::index_file_structure,
            index::index_save,
            index::index_kinds_in,
            index::index_class,
            index::index_function,
            index::index_search,
            index::index_usages,
            index::index_locate,
            index::index_declarations,
            index::index_find_usages,
            js::js_read_sources,
            js::js_type_files,
            blitz::blitz_read,
            blitz::blitz_write,
            blitz::blitz_keep_broken,
            history::history_list,
            history::history_read,
            spell::spell_check,
            spell::spell_suggest,
            spell::spell_set_words,
            mago::mago_open,
            mago::mago_analyze,
            mago::mago_close,
            mago::mago_check,
            mago::mago_project_issues,
            mago::mago_format,
            mago::mago_disable_rule,
            mago::mago_ensure_config,
            mago::mago_sync,
            mago::mago_set_levels,
            mago::mago_rules,
            watcher::watch_start,
            watcher::watch_stop,
            pty::terminal_shells,
            pty::pty_spawn,
            pty::pty_write,
            pty::pty_resize,
            pty::pty_kill,
            db::db_connect,
            db::db_test,
            db::db_disconnect,
            db::db_query,
            db::db_cancel,
            db::db_execute,
            db::db_set_password,
            db::db_has_password,
            xdebug::xdebug_listen,
            xdebug::xdebug_stop_listening,
            xdebug::xdebug_send,
            xdebug::xdebug_close,
            search::search_in_files,
            search::replace_in_files,
            search::replace_in_text,
        ])
        .on_page_load(|webview, payload| {
            // A page that (re)loads (Reload Window, a reload while developing) starts its own
            // language servers and terminals: the previous page's are nobody's any more. Left
            // running they pile up, and several servers on one project answer each other's
            // questions (Find Usages finding nothing while the usage count says 341).
            if webview.label() == "main" && payload.event() == tauri::webview::PageLoadEvent::Started {
                let app = webview.app_handle();
                app.state::<lsp::LspState>().stop_all();
                app.state::<pty::PtyState>().kill_all();
                app.state::<process::JobState>().kill_all();
            }
        })
        .setup(|app| {
            // The window starts hidden and the UI shows it once it knows what to show (the welcome
            // screen, or the reopened project maximized). If the page never gets that far, it
            // shows anyway: an empty window beats an invisible app.
            if let Some(window) = app.get_webview_window("main") {
                std::thread::spawn(move || {
                    std::thread::sleep(std::time::Duration::from_secs(3));
                    if !window.is_visible().unwrap_or(true) {
                        let _ = window.show();
                    }
                });
            }
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building PHPBlitz")
        .run(|app, event| {
            // Language servers, terminal shells and jobs are child processes: stop them with the app.
            if let tauri::RunEvent::Exit = event {
                app.state::<lsp::LspState>().stop_all();
                app.state::<pty::PtyState>().kill_all();
                app.state::<xdebug::XdebugState>().shutdown();
                app.state::<process::JobState>().kill_all();
            }
        });
}
