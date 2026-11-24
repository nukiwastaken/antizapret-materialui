import React, { useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  Alert, Avatar, Box, Button, CssBaseline, Divider, IconButton,
  MenuItem, Paper, Select, Slider, Snackbar, Stack, Switch, ThemeProvider,
  Tooltip, Typography, createTheme,
} from "@mui/material";
import {
  Brightness4, ContentCopy, Dashboard, Download, ExpandMore, Language,
  Palette, PlayArrow, Send, Settings, Shield, Stop, Tune, YouTube,
} from "@mui/icons-material";
import "./style.css";

const seed = { accent: "#267b70", mode: "light", radius: 12, compact: false };
const palettes = ["#267b70", "#315da8", "#b14a45", "#7954a3", "#247b9a", "#60734a"];

function App() {
  const [prefs, setPrefs] = useState(() => {
    try { return { ...seed, ...JSON.parse(localStorage.getItem("netbridge-theme")) }; }
    catch { return seed; }
  });
  const [toast, setToast] = useState("");
  const [running, setRunning] = useState({ zapret: false, telegram: false });
  const [page, setPage] = useState("overview");
  const theme = useMemo(() => createTheme({
    palette: {
      mode: prefs.mode,
      primary: { main: prefs.accent },
      background: { default: prefs.mode === "light" ? "#f4f6f8" : "#141a1c", paper: prefs.mode === "light" ? "#fff" : "#1e2628" },
      text: { primary: prefs.mode === "light" ? "#192425" : "#edf3f2", secondary: prefs.mode === "light" ? "#697779" : "#a6b4b3" },
      success: { main: "#38836f" },
    },
    shape: { borderRadius: prefs.radius },
    typography: { fontFamily: '"Inter", -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif', button: { textTransform: "none", fontWeight: 600 } },
  }), [prefs]);

  const savePrefs = (next) => {
    setPrefs(next);
    localStorage.setItem("netbridge-theme", JSON.stringify(next));
  };
  const openRelease = async (key) => {
    if (window.netbridge) await window.netbridge.openRelease(key);
    else window.open(key === "zapret" ? "https://github.com/Flowseal/zapret-mac-discord-youtube/releases" : "https://github.com/Flowseal/tg-ws-proxy/releases", "_blank");
  };
  const toggle = async (key) => {
    if (running[key]) {
      setToast("Остановите сервис в меню самого приложения");
      return;
    }
    if (!window.netbridge) {
      setToast("Запустите приложение на macOS, чтобы открыть установленный компонент");
      return;
    }
    const result = await window.netbridge.openComponent(key);
    if (result.ok) {
      setRunning((prev) => ({ ...prev, [key]: true }));
      setToast("Компонент открыт. Управление сервисом доступно в его меню");
    } else {
      setToast("Не найдено. Установите официальную сборку через кнопку «Установить»");
    }
  };
  const copyProxy = async () => {
    await navigator.clipboard?.writeText("127.0.0.1:1443");
    setToast("Адрес прокси скопирован");
  };

  return (
    <ThemeProvider theme={theme}>
      <CssBaseline />
      <Box className={`shell ${prefs.compact ? "compact" : ""}`}>
        <Box component="aside" className="sidebar">
          <Box className="brand"><Avatar className="brand-mark"><Language /></Avatar><Box><Typography fontWeight={750}>netbridge</Typography><Typography variant="caption" color="text.secondary">ИНТЕРНЕТ БЕЗ ГРАНИЦ</Typography></Box></Box>
          <Typography className="nav-label">РАБОЧЕЕ ПРОСТРАНСТВО</Typography>
          <Button className={`nav-item ${page === "overview" ? "selected" : ""}`} startIcon={<Dashboard />} onClick={() => setPage("overview")}>Обзор</Button>
          <Button className={`nav-item ${page === "appearance" ? "selected" : ""}`} startIcon={<Palette />} onClick={() => setPage("appearance")}>Оформление</Button>
          <Box className="sidebar-bottom">
            <Paper className="privacy-note" elevation={0}><Shield color="primary" fontSize="small" /><Typography variant="caption">Сервисы запускаются отдельно и сохраняют собственные настройки.</Typography></Paper>
            <Stack direction="row" alignItems="center" spacing={1}><Avatar sx={{ width: 30, height: 30, bgcolor: "primary.main" }}>M</Avatar><Box flex={1}><Typography variant="body2" fontWeight={600}>Мой Mac</Typography><Typography variant="caption" color="text.secondary">Локальное устройство</Typography></Box><Settings fontSize="small" color="action" /></Stack>
          </Box>
        </Box>
        <Box component="main" className="main">
          <Box className="topbar"><Box className="crumb">Netbridge <ExpandMore fontSize="small" /> <span>{page === "overview" ? "Обзор" : "Оформление"}</span></Box><Tooltip title="Переключить тему"><IconButton onClick={() => savePrefs({ ...prefs, mode: prefs.mode === "light" ? "dark" : "light" })}><Brightness4 /></IconButton></Tooltip></Box>
          {page === "overview" ? <Box className="content">
            <Stack direction="row" justifyContent="space-between" alignItems="flex-start" className="heading">
              <Box><Typography variant="h4" fontWeight={720}>Ваше подключение</Typography><Typography color="text.secondary" mt={0.7}>Управляйте инструментами доступа из одного места.</Typography></Box>
              <Button variant="outlined" startIcon={<Tune />} onClick={() => setPage("appearance")}>Настроить вид</Button>
            </Stack>
            <Paper className="status-strip" elevation={0}><span className="live-dot" /><Box flex={1}><Typography fontWeight={650}>Система готова</Typography><Typography variant="body2" color="text.secondary">Выберите нужный сервис ниже</Typography></Box><Typography variant="caption" color="text.secondary">macOS</Typography></Paper>
            <Typography className="section-title">СЕРВИСЫ</Typography>
            <Box className="service-grid">
              <ServiceCard icon={<YouTube />} color="#dc514d" label="ВИДЕО" title="YouTube" desc="ZapretMac помогает восстановить доступ к YouTube и другим сайтам." running={running.zapret} onToggle={() => toggle("zapret")} onInstall={() => openRelease("zapret")} />
              <ServiceCard icon={<Send />} color="#398fbd" label="МЕССЕНДЖЕР" title="Telegram" desc="Локальный MTProto-прокси с WebSocket-транспортом." running={running.telegram} onToggle={() => toggle("telegram")} onInstall={() => openRelease("telegram")} />
            </Box>
            <Paper className="proxy-row" elevation={0}><Avatar sx={{ bgcolor: "#e9f1fa", color: "#3472a8" }}><Send /></Avatar><Box flex={1}><Typography fontWeight={650}>Локальный прокси Telegram</Typography><Typography variant="body2" color="text.secondary">Адрес для подключения Telegram Desktop</Typography></Box><Typography className="proxy-address">127.0.0.1:1443</Typography><Tooltip title="Скопировать адрес"><IconButton onClick={copyProxy}><ContentCopy fontSize="small" /></IconButton></Tooltip></Paper>
            <Box className="footnote"><Shield fontSize="small" /><Typography variant="caption">Компоненты предоставлены Flowseal. Запуск ZapretMac может запросить пароль администратора для настройки сетевого сервиса.</Typography></Box>
          </Box> : <Box className="content appearance">
            <Typography variant="h4" fontWeight={720}>Оформление</Typography><Typography color="text.secondary" mt={0.7}>Подстройте интерфейс под себя.</Typography>
            <Paper className="settings-panel" elevation={0}>
              <Box className="setting-line"><Box><Typography fontWeight={650}>Цвет акцента</Typography><Typography variant="body2" color="text.secondary">Кнопки и активные элементы</Typography></Box><Stack direction="row" spacing={1}>{palettes.map((color) => <Tooltip key={color} title={color}><IconButton className={`swatch ${prefs.accent === color ? "active" : ""}`} style={{ "--swatch": color }} onClick={() => savePrefs({ ...prefs, accent: color })} /></Tooltip>)}</Stack></Box><Divider />
              <Box className="setting-line"><Box><Typography fontWeight={650}>Радиус углов</Typography><Typography variant="body2" color="text.secondary">{prefs.radius} px</Typography></Box><Slider sx={{ width: 180 }} min={4} max={20} step={2} value={prefs.radius} onChange={(_, value) => savePrefs({ ...prefs, radius: value })} /></Box><Divider />
              <Box className="setting-line"><Box><Typography fontWeight={650}>Компактный вид</Typography><Typography variant="body2" color="text.secondary">Уменьшить расстояния между элементами</Typography></Box><Switch checked={prefs.compact} onChange={(e) => savePrefs({ ...prefs, compact: e.target.checked })} /></Box><Divider />
              <Box className="setting-line"><Box><Typography fontWeight={650}>Цветовая схема</Typography><Typography variant="body2" color="text.secondary">Светлая или тёмная</Typography></Box><Select size="small" value={prefs.mode} onChange={(e) => savePrefs({ ...prefs, mode: e.target.value })}><MenuItem value="light">Светлая</MenuItem><MenuItem value="dark">Тёмная</MenuItem></Select></Box>
            </Paper>
          </Box>}
        </Box>
      </Box>
      <Snackbar open={Boolean(toast)} autoHideDuration={3600} onClose={() => setToast("")}><Alert severity="info" variant="filled">{toast}</Alert></Snackbar>
    </ThemeProvider>
  );
}

function ServiceCard({ icon, color, label, title, desc, running, onToggle, onInstall }) {
  return <Paper className="service-card" elevation={0}>
    <Stack direction="row" justifyContent="space-between" alignItems="center"><Avatar sx={{ bgcolor: `${color}16`, color }}>{icon}</Avatar><span className={`state ${running ? "on" : ""}`}><i />{running ? "Открыто" : "Не запущено"}</span></Stack>
    <Box mt={2.5}><Typography variant="overline" color="text.secondary">{label}</Typography><Typography variant="h5" fontWeight={700}>{title}</Typography><Typography color="text.secondary" variant="body2" mt={1}>{desc}</Typography></Box>
    <Stack direction="row" spacing={1} mt="auto" pt={3}><Button variant="contained" startIcon={running ? <Stop /> : <PlayArrow />} onClick={onToggle}>{running ? "Управление" : "Открыть"}</Button><Button variant="outlined" startIcon={<Download />} onClick={onInstall}>Установить</Button></Stack>
  </Paper>;
}

createRoot(document.getElementById("root")).render(<App />);
