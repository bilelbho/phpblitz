mod fs;
mod lsp;
mod mago;
mod process;
mod pty;
mod search;
mod watcher;

use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(lsp::LspState::default())
        .manage(mago::MagoState::default())
        .manage(watcher::WatchState::default())
        .manage(pty::PtyState::default())
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
            lsp::lsp_start,
            lsp::lsp_send,
            lsp::lsp_stop,
            mago::mago_open,
            mago::mago_close,
            mago::mago_check,
            mago::mago_project_issues,
            mago::mago_format,
            mago::mago_disable_rule,
            mago::mago_ensure_config,
            mago::mago_remove_file,
            watcher::watch_start,
            watcher::watch_stop,
            pty::terminal_shells,
            pty::pty_spawn,
            pty::pty_write,
            pty::pty_resize,
            pty::pty_kill,
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
            }
        });
}
