// Openbot spike: arranca el MISMO bundle del renderer que produce el build de
// electron-vite, dentro de un shell construido en Rust (Tauri 2, WebView2).
// Objetivo: medir el coste de la cáscara (RAM en reposo, tamaño, arranque en
// frío) sin portar funcionalidad: aquí no existe el proceso main de Electron,
// y el stub de preload solo evita que el bootstrap del renderer se casque.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    tauri::Builder::default()
        .setup(|app| {
            // El stub va primero: el script de inicialización corre antes que
            // cualquier script de la página, así el renderer encuentra un
            // window.electron presente aunque sin funciones implementadas.
            tauri::WebviewWindowBuilder::new(
                app,
                "main",
                tauri::WebviewUrl::App("index.html".into()),
            )
            .initialization_script(
                r#"(() => {
                    const stub = Object.create(null)
                    const rechazo = () => Promise.reject(new Error("tauri-spike: no hay IPC"))
                    window.electron = new Proxy(stub, {
                        get: (target, key) => (key in target ? target[key] : rechazo),
                        has: () => true,
                    })
                })()
            "#)
            .title("Openbot spike")
            .inner_size(1280.0, 800.0)
            .build()
            .map(|_| ())?;
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error arrancando la aplicación tauri");
}
