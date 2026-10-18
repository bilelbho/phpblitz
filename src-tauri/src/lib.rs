mod blitz;
mod db;
mod fs;
mod index;
mod lsp;
mod mago;
mod process;
mod pty;
mod search;
mod watcher;
mod xdebug;

use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .manage(lsp::LspState::default())
        .manage(mago::MagoState::default())
        .manage(index::IndexState::default())
        .manage(watcher::WatchState::default())
        .manage(pty::PtyState::default())
        .manage(db::DbState::default())
        .manage(xdebug::XdebugState::default())
        .invoke_handler(tauri::generate_handler![
            fs::list_dir,
            fs::list_files,
            fs::read_file,
            fs::write_file,
            fs::create_file,
            fs::create_dir,
            fs::rename_path,
            fs::copy_path,
            fs::delete_to_trash,
            process::run_process,
            process::run_shell,
            process::find_executable,
            process::reveal_in_explorer,
            process::open_external,
            process::updater_supported,
            lsp::lsp_start,
            lsp::lsp_send,
            lsp::lsp_stop,
            index::index_open,
            index::index_update,
            index::index_update_text,
            index::index_save,
            index::index_kinds,
            index::index_class,
            index::index_function,
            index::index_search,
            index::index_usages,
            index::index_locate,
            index::index_declarations,
            index::index_find_usages,
            blitz::blitz_read,
            blitz::blitz_write,
            mago::mago_open,
            mago::mago_analyze,
            mago::mago_close,
            mago::mago_check,
            mago::mago_project_issues,
            mago::mago_format,
            mago::mago_disable_rule,
            mago::mago_ensure_config,
            mago::mago_sync,
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
        .build(tauri::generate_context!())
        .expect("error while building PHPBlitz")
        .run(|app, event| {
            // Language servers and terminal shells are child processes: stop them with the app.
            if let tauri::RunEvent::Exit = event {
                app.state::<lsp::LspState>().stop_all();
                app.state::<pty::PtyState>().kill_all();
                app.state::<xdebug::XdebugState>().shutdown();
            }
        });
}
