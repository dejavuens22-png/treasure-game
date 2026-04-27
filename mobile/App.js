import React, { useMemo, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  SafeAreaView,
  ScrollView,
  StatusBar,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from "react-native";

const BASE_URL = "http://192.168.0.21:3001";

const theme = {
  bg: "#06080F",
  panel: "#121826",
  panelSoft: "#1A2338",
  text: "#EAF0FF",
  muted: "#8D9AB8",
  neon: "#31E1FF",
  gold: "#F6C764",
  danger: "#FF6E8A",
  success: "#6AF0A7",
};

async function api(path, options = {}, token) {
  const headers = { "Content-Type": "application/json", ...(options.headers || {}) };
  if (token) headers.Authorization = `Bearer ${token}`;

  const res = await fetch(`${BASE_URL}${path}`, { ...options, headers });
  const data = await res.json().catch(() => ({}));

  if (!res.ok) {
    throw new Error(data.message || "Istek basarisiz.");
  }
  return data;
}

function GameCard({ title, children, right }) {
  return (
    <View style={styles.card}>
      <View style={styles.cardHeader}>
        <Text style={styles.cardTitle}>{title}</Text>
        {right ? <Text style={styles.cardRight}>{right}</Text> : null}
      </View>
      {children}
    </View>
  );
}

export default function App() {
  const [mode, setMode] = useState("login");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [token, setToken] = useState("");
  const [screen, setScreen] = useState("game");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [locationLoading, setLocationLoading] = useState(false);
  const [treasureLoading, setTreasureLoading] = useState(false);
  const [walletLoading, setWalletLoading] = useState(false);
  const [lastSpawnInfo, setLastSpawnInfo] = useState(null);
  const [treasure, setTreasure] = useState(null);
  const [wallet, setWallet] = useState(null);
  const [collecting, setCollecting] = useState(false);

  const authReady = useMemo(() => username.trim() && password.trim(), [username, password]);
  const isLoggedIn = Boolean(token);

  const runAuth = async (type) => {
    if (!authReady) {
      Alert.alert("Eksik Bilgi", "Username ve password gir.");
      return;
    }

    setBusy(true);
    setMessage("");
    try {
      if (type === "register") {
        const reg = await api("/auth/register", {
          method: "POST",
          body: JSON.stringify({ username: username.trim(), password }),
        });
        setMessage(reg.message || "Kayit basarili. Simdi giris yap.");
        setMode("login");
      } else {
        const login = await api("/auth/login", {
          method: "POST",
          body: JSON.stringify({ username: username.trim(), password }),
        });
        setToken(login.token);
        setMessage("Giris basarili.");
      }
    } catch (err) {
      setMessage(err.message);
    } finally {
      setBusy(false);
    }
  };

  const sendLocation = async () => {
    setLocationLoading(true);
    setMessage("");
    try {
      const lat = 41 + Math.random() * 0.01;
      const lng = 29 + Math.random() * 0.01;
      const res = await api(
        "/game/location",
        {
          method: "POST",
          body: JSON.stringify({ lat, lng }),
        },
        token
      );
      setLastSpawnInfo(res.spawn || null);
      setMessage(res.message || "Konum gonderildi.");
    } catch (err) {
      setMessage(err.message);
    } finally {
      setLocationLoading(false);
    }
  };

  const checkTreasure = async () => {
    setTreasureLoading(true);
    setMessage("");
    try {
      const res = await api("/game/treasure", { method: "GET" }, token);
      setTreasure(res.activeTreasure || null);
      setMessage(res.activeTreasure ? "Aktif treasure bulundu." : "Su an aktif treasure yok.");
    } catch (err) {
      setMessage(err.message);
    } finally {
      setTreasureLoading(false);
    }
  };

  const collectTreasure = async () => {
    setCollecting(true);
    setMessage("");
    try {
      const res = await api("/game/treasure/collect", { method: "POST" }, token);
      setMessage(`${res.message} (+${res.reward} token)`);
      setTreasure(null);
      await loadWallet();
    } catch (err) {
      setMessage(err.message);
    } finally {
      setCollecting(false);
    }
  };

  const loadWallet = async () => {
    setWalletLoading(true);
    setMessage("");
    try {
      const res = await api("/wallet", { method: "GET" }, token);
      setWallet(res);
    } catch (err) {
      setMessage(err.message);
    } finally {
      setWalletLoading(false);
    }
  };

  const logout = () => {
    setToken("");
    setTreasure(null);
    setWallet(null);
    setLastSpawnInfo(null);
    setMessage("Cikis yapildi.");
  };

  if (!isLoggedIn) {
    return (
      <SafeAreaView style={styles.safe}>
        <StatusBar barStyle="light-content" />
        <View style={styles.authContainer}>
          <Text style={styles.brand}>TREASURE RUSH</Text>
          <Text style={styles.subtitle}>Dark Ops Edition</Text>

          <GameCard title={mode === "login" ? "Login" : "Register"} right="ONLINE">
            <TextInput
              style={styles.input}
              placeholder="Username"
              placeholderTextColor={theme.muted}
              value={username}
              onChangeText={setUsername}
              autoCapitalize="none"
            />
            <TextInput
              style={styles.input}
              placeholder="Password"
              placeholderTextColor={theme.muted}
              value={password}
              onChangeText={setPassword}
              secureTextEntry
            />

            <TouchableOpacity
              style={[styles.button, styles.neonButton, busy && styles.buttonDisabled]}
              disabled={busy}
              onPress={() => runAuth(mode)}
            >
              {busy ? (
                <ActivityIndicator color="#021017" />
              ) : (
                <Text style={styles.neonButtonText}>
                  {mode === "login" ? "LOGIN" : "REGISTER"}
                </Text>
              )}
            </TouchableOpacity>

            <TouchableOpacity
              style={[styles.button, styles.secondaryButton]}
              onPress={() => setMode(mode === "login" ? "register" : "login")}
            >
              <Text style={styles.secondaryButtonText}>
                {mode === "login" ? "Hesabin yok mu? Register" : "Hesabin var mi? Login"}
              </Text>
            </TouchableOpacity>
          </GameCard>

          {message ? <Text style={styles.message}>{message}</Text> : null}
          <Text style={styles.hint}>Backend: {BASE_URL}</Text>
        </View>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.safe}>
      <StatusBar barStyle="light-content" />
      <View style={styles.topBar}>
        <Text style={styles.brandSmall}>TREASURE RUSH</Text>
        <TouchableOpacity onPress={logout} style={styles.logoutChip}>
          <Text style={styles.logoutText}>Cikis</Text>
        </TouchableOpacity>
      </View>

      <View style={styles.tabRow}>
        <TouchableOpacity
          style={[styles.tabButton, screen === "game" && styles.tabActive]}
          onPress={() => setScreen("game")}
        >
          <Text style={[styles.tabText, screen === "game" && styles.tabTextActive]}>Oyun</Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={[styles.tabButton, screen === "wallet" && styles.tabActive]}
          onPress={() => {
            setScreen("wallet");
            loadWallet();
          }}
        >
          <Text style={[styles.tabText, screen === "wallet" && styles.tabTextActive]}>Wallet</Text>
        </TouchableOpacity>
      </View>

      <ScrollView contentContainerStyle={styles.content}>
        {screen === "game" ? (
          <>
            <GameCard title="Oyuncu Kontrol Merkezi" right="LIVE">
              <TouchableOpacity
                style={[styles.button, styles.neonButton, locationLoading && styles.buttonDisabled]}
                onPress={sendLocation}
                disabled={locationLoading}
              >
                {locationLoading ? (
                  <ActivityIndicator color="#021017" />
                ) : (
                  <Text style={styles.neonButtonText}>Konum Gonder</Text>
                )}
              </TouchableOpacity>

              <TouchableOpacity
                style={[styles.button, styles.goldButton, treasureLoading && styles.buttonDisabled]}
                onPress={checkTreasure}
                disabled={treasureLoading}
              >
                {treasureLoading ? (
                  <ActivityIndicator color="#2B1B00" />
                ) : (
                  <Text style={styles.goldButtonText}>Treasure Kontrol Et</Text>
                )}
              </TouchableOpacity>
            </GameCard>

            <GameCard title="Spawn Durumu" right={lastSpawnInfo?.spawned ? "SPAWNED" : "WAITING"}>
              {lastSpawnInfo ? (
                <>
                  <Text style={styles.dataRow}>spawned: {String(lastSpawnInfo.spawned)}</Text>
                  <Text style={styles.dataRow}>reason: {lastSpawnInfo.reason || "-"}</Text>
                  {lastSpawnInfo.treasure ? (
                    <Text style={styles.dataRow}>
                      id #{lastSpawnInfo.treasure.id} | {lastSpawnInfo.treasure.type}
                    </Text>
                  ) : null}
                </>
              ) : (
                <Text style={styles.muted}>Konum gonderdikten sonra spawn bilgisi gorunur.</Text>
              )}
            </GameCard>

            <GameCard title="Treasure" right={treasure ? "ACTIVE" : "NONE"}>
              {treasure ? (
                <>
                  <Text style={styles.dataRow}>ID: {treasure.id}</Text>
                  <Text style={styles.dataRow}>Type: {treasure.type}</Text>
                  <Text style={styles.dataRow}>
                    Lat/Lng: {Number(treasure.lat).toFixed(5)}, {Number(treasure.lng).toFixed(5)}
                  </Text>
                  <TouchableOpacity
                    style={[styles.button, styles.collectButton, collecting && styles.buttonDisabled]}
                    onPress={collectTreasure}
                    disabled={collecting}
                  >
                    {collecting ? (
                      <ActivityIndicator color="#122000" />
                    ) : (
                      <Text style={styles.collectButtonText}>Treasure Collect</Text>
                    )}
                  </TouchableOpacity>
                </>
              ) : (
                <Text style={styles.muted}>Aktif treasure yok. Once "Treasure Kontrol Et".</Text>
              )}
            </GameCard>
          </>
        ) : (
          <GameCard title="Wallet / Token" right="VAULT">
            {walletLoading ? (
              <ActivityIndicator color={theme.neon} />
            ) : wallet ? (
              <>
                <Text style={styles.walletBalance}>{wallet.wallet_tokens ?? wallet.walletTokens ?? 0}</Text>
                <Text style={styles.walletLabel}>Toplam Token</Text>
                <Text style={styles.muted}>Kullanici: {wallet.username || username}</Text>
              </>
            ) : (
              <Text style={styles.muted}>Wallet verisini yuklemek icin sekmeye tekrar dokun.</Text>
            )}
          </GameCard>
        )}
      </ScrollView>

      {message ? <Text style={styles.bottomMessage}>{message}</Text> : null}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: {
    flex: 1,
    backgroundColor: theme.bg,
  },
  authContainer: {
    flex: 1,
    padding: 18,
    justifyContent: "center",
  },
  brand: {
    color: theme.gold,
    fontSize: 34,
    fontWeight: "800",
    letterSpacing: 1.4,
    textAlign: "center",
  },
  subtitle: {
    color: theme.neon,
    fontSize: 14,
    textAlign: "center",
    marginBottom: 18,
    marginTop: 4,
  },
  card: {
    backgroundColor: theme.panel,
    borderColor: "#233151",
    borderWidth: 1,
    borderRadius: 16,
    padding: 16,
    marginBottom: 12,
    shadowColor: "#000",
    shadowOffset: { width: 0, height: 6 },
    shadowOpacity: 0.35,
    shadowRadius: 12,
    elevation: 6,
  },
  cardHeader: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    marginBottom: 10,
  },
  cardTitle: {
    color: theme.text,
    fontSize: 18,
    fontWeight: "700",
  },
  cardRight: {
    color: theme.neon,
    fontSize: 12,
    fontWeight: "700",
  },
  input: {
    backgroundColor: theme.panelSoft,
    color: theme.text,
    borderColor: "#2A3757",
    borderWidth: 1,
    borderRadius: 12,
    paddingHorizontal: 12,
    paddingVertical: 12,
    marginBottom: 10,
    fontSize: 15,
  },
  button: {
    borderRadius: 12,
    paddingVertical: 12,
    alignItems: "center",
    justifyContent: "center",
    marginTop: 6,
  },
  neonButton: {
    backgroundColor: theme.neon,
  },
  neonButtonText: {
    color: "#041822",
    fontWeight: "800",
    letterSpacing: 0.5,
  },
  secondaryButton: {
    backgroundColor: "#223254",
    borderWidth: 1,
    borderColor: "#355083",
  },
  secondaryButtonText: {
    color: theme.text,
    fontWeight: "600",
  },
  goldButton: {
    backgroundColor: theme.gold,
  },
  goldButtonText: {
    color: "#2B1B00",
    fontWeight: "800",
  },
  collectButton: {
    backgroundColor: "#B7FF5A",
    marginTop: 14,
  },
  collectButtonText: {
    color: "#182700",
    fontWeight: "900",
  },
  buttonDisabled: {
    opacity: 0.7,
  },
  message: {
    color: theme.success,
    textAlign: "center",
    marginTop: 8,
  },
  hint: {
    color: theme.muted,
    textAlign: "center",
    marginTop: 8,
    fontSize: 12,
  },
  topBar: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    paddingHorizontal: 16,
    paddingTop: 8,
  },
  brandSmall: {
    color: theme.gold,
    fontWeight: "800",
    fontSize: 18,
  },
  logoutChip: {
    backgroundColor: "#3A2030",
    borderColor: "#804060",
    borderWidth: 1,
    paddingVertical: 7,
    paddingHorizontal: 12,
    borderRadius: 10,
  },
  logoutText: {
    color: "#FF8BA7",
    fontWeight: "700",
  },
  tabRow: {
    flexDirection: "row",
    paddingHorizontal: 16,
    marginTop: 14,
    gap: 10,
  },
  tabButton: {
    flex: 1,
    backgroundColor: "#15203A",
    borderRadius: 12,
    borderWidth: 1,
    borderColor: "#273B67",
    paddingVertical: 10,
    alignItems: "center",
  },
  tabActive: {
    borderColor: theme.neon,
    backgroundColor: "#1A2E4D",
  },
  tabText: {
    color: theme.muted,
    fontWeight: "700",
  },
  tabTextActive: {
    color: theme.text,
  },
  content: {
    padding: 16,
    paddingBottom: 28,
  },
  muted: {
    color: theme.muted,
  },
  dataRow: {
    color: theme.text,
    marginBottom: 6,
  },
  walletBalance: {
    color: theme.gold,
    fontSize: 42,
    fontWeight: "900",
    textAlign: "center",
    marginTop: 8,
  },
  walletLabel: {
    color: theme.text,
    textAlign: "center",
    marginBottom: 12,
    fontWeight: "700",
  },
  bottomMessage: {
    color: theme.neon,
    textAlign: "center",
    paddingHorizontal: 16,
    paddingBottom: 12,
    fontWeight: "600",
  },
});
