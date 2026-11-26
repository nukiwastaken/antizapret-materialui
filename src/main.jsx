import React, { useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  Alert, Avatar, Box, Button, CssBaseline, Divider, IconButton, LinearProgress,
  Dialog, DialogTitle, DialogContent, DialogActions, Table, TableBody, TableHead, TableRow, TableCell,
  MenuItem, Paper, Select, Slider, Snackbar, Stack, Switch, ThemeProvider,
  Tooltip, Typography, createTheme,
} from "@mui/material";
import {
  Brightness4, ContentCopy, Dashboard,
  Palette, PlayArrow, Send, Shield, Stop, Tune, YouTube, AutoFixHigh, Assessment,
} from "@mui/icons-material";
import "./style.css";
import logo from "../assets/netbridge.png";
import { version } from "../package.json";

const seed = { accent: "#267b70", mode: "light", radius: 8, compact: false };
const palettes = ["#267b70", "#315da8", "#b14a45", "#7954a3", "#247b9a", "#60734a"];

function App() {
  const [prefs, setPrefs] = useState(() => {
    try { return { ...seed, ...JSON.parse(localStorage.getItem("netbridge-theme")) }; }
    catch { return seed; }
  });
  const [toast, setToast] = useState("");
  const [services, setServices] = useState({
    zapret: { running: false, busy: false, installed: false },
    telegram: { running: false, busy: false, installed: false },
  });
  const [reportOpen, setReportOpen] = useState(false);
  const [page, setPage] = useState("overview");
  useEffect(() => {
    if (!window.netbridge) return;
    let mounted = true;
    const unsubscribe = window.netbridge.onState((state) => { if (mounted) setServices(state); });
    window.netbridge.state().then((result) => {
      if (mounted && result.ok) setServices(result.value);
    }).catch((error) => { if (mounted) setToast(error.message); });
    return () => { mounted = false; unsubscribe(); };
  }, []);
  const theme = useMemo(() => createTheme({
    palette: {
      mode: prefs.mode,
      primary: { main: prefs.accent },
      background: { default: prefs.mode === "light" ? "#f4f6f8" : "#141a1c", paper: prefs.mode === "light" ? "#fff" : "#1e2628" },
      text: { primary: prefs.mode === "light" ? "#192425" : "#edf3f2", secondary: prefs.mode === "light" ? "#697779" : "#a6b4b3" },
      success: { main: "#38836f" },
    },
    shape: { borderRadius: prefs.radius },
    typography: { fontFamily: '"Inter", -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif', allVariants: { letterSpacing: 0 }, button: { textTransform: "none", fontWeight: 600 } },
  }), [prefs]);

  const savePrefs = (next) => {
    setPrefs(next);
    localStorage.setItem("netbridge-theme", JSON.stringify(next));
  };
  const action = async (fn, success) => {
    if (!window.netbridge) {
      setToast("Управление доступно в приложении macOS. В браузере показан интерфейс.");
      return;
    }
    try {
      const result = await fn(window.netbridge);
      if (!result.ok) setToast(result.error);
      else if (success) setToast(success);
    } catch (error) { setToast(error.message); }
  };
  const toggle = (key) => action((api) => api.toggle(key, !services[key].running));
  const active = Object.values(services).filter((service) => service.running).length;
  const busy = Object.values(services).some((service) => service.busy);

  return (
    <ThemeProvider theme={theme}>
      <CssBaseline />
      <Box className={`shell ${prefs.compact ? "compact" : ""}`}>
        <Box component="aside" className="sidebar">
          <Box className="brand"><img className="brand-mark" src={logo} alt="Логотип Netbridge" draggable={false} /><Typography className="brand-name" fontWeight={750}>netbridge</Typography></Box>
          <Typography className="nav-label">РАБОЧЕЕ ПРОСТРАНСТВО</Typography>
          <Button className={`nav-item ${page === "overview" ? "selected" : ""}`} startIcon={<Dashboard />} onClick={() => setPage("overview")}>Обзор</Button>
          <Button className={`nav-item ${page === "appearance" ? "selected" : ""}`} startIcon={<Palette />} onClick={() => setPage("appearance")}>Оформление</Button>
          <Box className="sidebar-bottom">
            <Paper className="privacy-note" elevation={0}><Shield color="primary" fontSize="small" /><Typography variant="caption">Flowseal · ZapretMac 1.1.2<br />TG WS Proxy 1.12.0</Typography></Paper>
          </Box>
        </Box>
        <Box component="main" className="main">
          <Box className="topbar"><Tooltip title="Переключить тему"><IconButton onClick={() => savePrefs({ ...prefs, mode: prefs.mode === "light" ? "dark" : "light" })}><Brightness4 /></IconButton></Tooltip></Box>
          {page === "overview" ? <Box className="content">
            <Stack direction="row" justifyContent="space-between" alignItems="flex-start" className="heading">
              <Box><Typography variant="h4" fontWeight={720}>Ваше подключение</Typography><Typography color="text.secondary" mt={0.7}>Управляйте инструментами доступа из одного места.</Typography></Box>
              <Button variant="outlined" startIcon={<Tune />} onClick={() => setPage("appearance")}>Настроить вид</Button>
            </Stack>
            <Paper className="status-strip" elevation={0}><span className={`live-dot ${active ? "" : "inactive"}`} /><Box flex={1}><Typography fontWeight={650}>{busy ? "Настройка подключения" : active ? `Активных сервисов: ${active}` : "Сервисы выключены"}</Typography><Typography variant="body2" color="text.secondary">{window.netbridge ? "Локальное устройство · macOS" : "Предпросмотр · без доступа к сервисам"}</Typography></Box><Typography variant="caption" color="text.secondary">Netbridge {version}</Typography></Paper>
            <Typography className="section-title">СЕРВИСЫ</Typography>
            <Box className="service-grid">
              <ServiceCard icon={<YouTube />} color="#dc514d" label="ВИДЕО" title="YouTube" desc="ZapretMac · автоматический подбор стратегии" state={services.zapret} onToggle={() => toggle("zapret")} onOptimize={() => action((api) => api.optimize())} onCancel={() => action((api) => api.cancel())} />
              <ServiceCard icon={<Send />} color="#398fbd" label="МЕССЕНДЖЕР" title="Telegram" desc="TG WS Proxy · локальный MTProto через WebSocket" state={services.telegram} onToggle={() => toggle("telegram")} />
            </Box>
            <Paper className="proxy-row" elevation={0}><Avatar sx={{ bgcolor: "#e9f1fa", color: "#3472a8" }}><Send /></Avatar><Box flex={1}><Typography fontWeight={650}>Прокси Telegram</Typography><Typography variant="body2" color="text.secondary">{services.telegram.running ? "Локальный порт слушает · маршрут Telegram не проверен" : "Ожидает запуска"}</Typography></Box><Typography className="proxy-address">{services.telegram.address || "—"}</Typography><Tooltip title="Скопировать ссылку с ключом"><span><IconButton disabled={!services.telegram.running} onClick={() => action((api) => api.copyTelegram(), "Ссылка скопирована")}><ContentCopy fontSize="small" /></IconButton></span></Tooltip><Button disabled={!services.telegram.running} onClick={() => action((api) => api.connectTelegram())} startIcon={<Send />}>Подключить</Button></Paper>
            {services.zapret.strategy && <Box className="strategy-row"><Typography variant="body2" color="text.secondary">Стратегия: <strong>{services.zapret.strategy}</strong></Typography><Button size="small" startIcon={<Assessment />} disabled={!services.zapret.report} onClick={() => setReportOpen(true)}>Отчёт</Button></Box>}
            <Box className="footnote"><Shield fontSize="small" /><Typography variant="caption">Zapret требует разрешения администратора. Подбор временно переключает сетевые стратегии; HTTPS-проверки не гарантируют воспроизведение видео. Подключение прокси подтверждается в Telegram.</Typography></Box>
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
      <Dialog open={reportOpen} onClose={() => setReportOpen(false)} fullWidth maxWidth="md">
        <DialogTitle>Результаты автоподбора</DialogTitle><DialogContent>
          <Typography variant="body2" color="text.secondary" mb={2}>По два HTTPS-запроса к YouTube, превью и маршрутизатору Google Video. Приоритет: число успешных ответов, затем суммарная задержка. Ответ Google Video не подтверждает загрузку видеопотока. Браузерный QUIC/HTTP3 и воспроизведение этим тестом не проверяются.</Typography>
          {services.zapret.report?.configRevision === "youtube-quic-1" && <Alert severity="info" sx={{ mb: 2 }}>Домены списка Google/YouTube включены в QUIC-профиль. Это настройка правил, а не подтверждение воспроизведения видео.</Alert>}
          <Typography variant="body2">{services.zapret.report?.cached ? "Сохранённый профиль · повторная проверка пройдена" : "Выбранная стратегия"}: {services.zapret.report?.strategy}</Typography>
          <Table size="small"><TableHead><TableRow><TableCell>Стратегия</TableCell><TableCell>HTTPS</TableCell><TableCell>Время, с</TableCell><TableCell>YouTube</TableCell></TableRow></TableHead><TableBody>{(services.zapret.report?.results || "").split("\n").filter(Boolean).map((line) => { const [id, score, time, yt] = line.split("\t"); return <TableRow key={id} selected={id === services.zapret.report?.strategy}><TableCell>{id}</TableCell><TableCell>{score}/6</TableCell><TableCell>{time}</TableCell><TableCell>{yt}/2</TableCell></TableRow>; })}</TableBody></Table>
        </DialogContent><DialogActions><Button onClick={() => setReportOpen(false)}>Закрыть</Button></DialogActions>
      </Dialog>
      <Snackbar open={Boolean(toast)} autoHideDuration={7000} onClose={() => setToast("")}><Alert severity="info" variant="filled" onClose={() => setToast("")}>{toast}</Alert></Snackbar>
    </ThemeProvider>
  );
}

function ServiceCard({ icon, color, label, title, desc, state, onToggle, onOptimize, onCancel }) {
  return <Paper className="service-card" elevation={0}>
    <Stack direction="row" justifyContent="space-between" alignItems="center"><Avatar sx={{ bgcolor: `${color}16`, color }}>{icon}</Avatar><span className={`state ${state.running ? "on" : ""}`}><i />{state.busy ? "Настройка…" : state.running ? "Сервис работает" : "Выключен"}</span></Stack>
    <Box mt={2.5}><Typography variant="overline" color="text.secondary">{label}</Typography><Typography variant="h5" fontWeight={700}>{title}</Typography><Typography color="text.secondary" variant="body2" mt={1}>{desc}</Typography></Box>
    {state.busy && <Box mt={2}><LinearProgress /><Typography variant="caption" color="text.secondary" display="block" mt={1} role="status">{state.message}</Typography></Box>}
    {state.error && <Alert severity="error" sx={{ mt: 2, overflowWrap: "anywhere", fontSize: 12 }}>{state.error}</Alert>}
    <Stack direction="row" spacing={1} mt="auto" pt={3} flexWrap="wrap" useFlexGap>
      <Button disabled={state.busy} variant="contained" startIcon={state.running ? <Stop /> : <PlayArrow />} onClick={onToggle}>{state.running ? "Выключить" : "Включить"}</Button>
      {onOptimize && <Tooltip title="Повторно подобрать стратегию"><span><IconButton color="primary" disabled={state.busy} onClick={onOptimize} aria-label="Автоподбор стратегии"><AutoFixHigh /></IconButton></span></Tooltip>}
      {onCancel && state.busy && state.cancellable && <Button onClick={onCancel} startIcon={<Stop />}>Отменить</Button>}
    </Stack>
  </Paper>;
}

createRoot(document.getElementById("root")).render(<App />);
