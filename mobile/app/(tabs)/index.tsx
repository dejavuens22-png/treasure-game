import React, { useEffect, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  Modal,
  SafeAreaView,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from "react-native";
import * as Location from "expo-location";
import MapView, { Marker } from "react-native-maps";

const BASE_URL = "https://treasure-game-backend.onrender.com";
const TREASURE_COLLECT_DISTANCE_METERS = 50;
const LOCATION_SEND_INTERVAL_MS = 3500;

const theme = {
  bg: "#10233F",
  hud: "rgba(22, 38, 70, 0.9)",
  panel: "rgba(30, 49, 86, 0.92)",
  neon: "#56E6FF",
  gold: "#FFD66B",
  text: "#F1F6FF",
  muted: "#AFC2E9",
  success: "#6AF0A7",
  danger: "#FF7C93",
};

type SpawnInfo = {
  spawned?: boolean;
  reason?: string;
  treasure?: { id: number; lat: number; lng: number; type: string };
};

type Treasure = {
  id: number;
  lat: number;
  lng: number;
  type?: string;
  value?: number;
};

type DetectorItem = {
  id: string;
  name: string;
  icon: string;
  feature: string;
};

type ShopDetectorItem = {
  id: string;
  name: string;
  icon: string;
  price: number;
  range: string;
  digSpeed: string;
  description: string;
};

type TokenPack = { id: string; amount: number; priceText: string };

const shopDetectors: ShopDetectorItem[] = [
  { id: "mini", name: "Mini Dedektör", icon: "📡", price: 100, range: "Kisa", digSpeed: "Yavas", description: "Baslangic icin hafif ve pratik." },
  { id: "street", name: "Sokak Dedektörü", icon: "🧭", price: 250, range: "Kisa-Orta", digSpeed: "Yavas", description: "Sehir icinde hizli tarama." },
  { id: "bronze", name: "Bronz Dedektör", icon: "🟤", price: 500, range: "Orta", digSpeed: "Orta", description: "Daha genis algilama alani." },
  { id: "bronze_plus", name: "Gelişmiş Bronz", icon: "🟫", price: 900, range: "Orta", digSpeed: "Orta", description: "Daha stabil sinyal ve daha az sapma." },
  { id: "silver", name: "Gümüş Dedektör", icon: "⚙️", price: 1500, range: "Orta-Uzak", digSpeed: "Orta", description: "Orta-uzak hazineleri daha net gosterir." },
  { id: "radar", name: "Radar Dedektörü", icon: "📶", price: 2500, range: "Uzak", digSpeed: "Orta", description: "Genis alanda radar taramasi yapar." },
  { id: "gold", name: "Altın Dedektör", icon: "🟡", price: 5000, range: "Uzak", digSpeed: "Hizli", description: "Nadir hazineleri daha hizli bulur." },
  { id: "pro", name: "Pro Dedektör", icon: "🧪", price: 7500, range: "Uzak+", digSpeed: "Hizli", description: "Filtreli tarama: daha az yanlis alarm." },
  { id: "platinum", name: "Platin Dedektör", icon: "⬜️", price: 10000, range: "Cok Uzak", digSpeed: "Hizli", description: "Stabil sinyal, genis kapsama." },
  { id: "diamond", name: "Elmas Dedektör", icon: "💠", price: 15000, range: "Cok Uzak+", digSpeed: "Cok Hizli", description: "Nadir hedefleri daha net ayiklar." },
  { id: "ultra", name: "Ultra Dedektör", icon: "🚀", price: 25000, range: "Maksimum", digSpeed: "Cok Hizli", description: "Hizli tarama + hizli kazi." },
  { id: "legendary", name: "Efsane Dedektör", icon: "💎", price: 50000, range: "Maksimum+", digSpeed: "Cok Hizli", description: "En genis alan + hizli kazi." },
  { id: "mythic", name: "Mitik Dedektör", icon: "🔮", price: 75000, range: "Maksimum+", digSpeed: "Asiri Hizli", description: "Gizemli frekans: daha iyi hedefleme." },
  { id: "cosmic", name: "Kozmik Dedektör", icon: "🌌", price: 100000, range: "Sinirsiz", digSpeed: "Asiri Hizli", description: "Kozmik tarama: genis capli av." },
  { id: "royal", name: "Kraliyet Dedektör", icon: "👑", price: 250000, range: "Sinirsiz+", digSpeed: "Aninda", description: "Elit avcilar icin ust seviye performans." },
].sort((a, b) => a.price - b.price);

const tokenPacks: TokenPack[] = [
  { id: "p100", amount: 100, priceText: "₺29,99" },
  { id: "p500", amount: 500, priceText: "₺99,99" },
  { id: "p1000", amount: 1000, priceText: "₺179,99" },
  { id: "p5000", amount: 5000, priceText: "₺699,99" },
];

async function api(path: string, options: RequestInit = {}, token?: string) {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    ...(options.headers as Record<string, string>),
  };
  if (token) headers.Authorization = `Bearer ${token}`;
  try {
    console.log("API REQUEST:", BASE_URL + path);
  
    const response = await fetch(`${BASE_URL}${path}`, {
      ...options,
      headers,
    });
  
    const data = await response.json().catch(() => ({}));
  
    console.log("API RESPONSE:", data);
  
    if (!response.ok) {
      throw new Error(data.message || "Istek basarisiz.");
    }
  
    return data;
  } catch (err) {
    console.log("API ERROR:", err);
    throw err;
  }
}

const toRadians = (degrees: number) => (degrees * Math.PI) / 180;

const distanceMeters = (lat1: number, lng1: number, lat2: number, lng2: number) => {
  const earthRadius = 6371000;
  const dLat = toRadians(lat2 - lat1);
  const dLng = toRadians(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(toRadians(lat1)) *
      Math.cos(toRadians(lat2)) *
      Math.sin(dLng / 2) *
      Math.sin(dLng / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return earthRadius * c;
};

export default function HomeScreen() {
  const [mode, setMode] = useState<"login" | "register">("login");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [token, setToken] = useState("");
  const [loading, setLoading] = useState(false);
  const [collecting, setCollecting] = useState(false);
  const [message, setMessage] = useState("");
  const [spawnInfo, setSpawnInfo] = useState<SpawnInfo | null>(null);
  const [treasure, setTreasure] = useState<Treasure | null>(null);
  const [wallet, setWallet] = useState<{ wallet_tokens?: number; walletTokens?: number } | null>(
    null
  );
  const [location, setLocation] = useState<{ lat: number; lng: number } | null>(null);
  const [locationPermissionState, setLocationPermissionState] = useState<
    "idle" | "granted" | "denied" | "error"
  >("idle");
  const [locationError, setLocationError] = useState("");
  const [showWalletPanel, setShowWalletPanel] = useState(false);
  const [showTreasurePanel, setShowTreasurePanel] = useState(false);
  const [activeTab, setActiveTab] = useState<"home" | "maps" | "shop">("maps");
  const [friendHandle, setFriendHandle] = useState("");
  const [friends, setFriends] = useState<string[]>(["Nova", "Kaan", "Luna"]);
  const [ownedDetectors] = useState<DetectorItem[]>([
    { id: "owned_1", name: "Baslangic Dedektoru", icon: "📡", feature: "Yakin algilama" },
    { id: "owned_2", name: "Bronz Dedektoru", icon: "🟤", feature: "Genis alan tarama" },
  ]);
  const [showTokenShop, setShowTokenShop] = useState(false);
  const watchSubscriptionRef = useRef<Location.LocationSubscription | null>(null);
  const lastLocationSentRef = useRef(0);

  const canAuth = useMemo(() => username.trim() && password.trim(), [username, password]);
  const playerStatus = locationPermissionState === "granted" ? "ONLINE" : "OFFLINE";

  const treasureDistance = useMemo(() => {
    if (!location || !treasure) return null;
    return distanceMeters(location.lat, location.lng, treasure.lat, treasure.lng);
  }, [location, treasure]);
  const canCollectTreasure =
    typeof treasureDistance === "number" && treasureDistance <= TREASURE_COLLECT_DISTANCE_METERS;

  const updateSpawnMessage = (spawn?: SpawnInfo) => {
    if (!spawn) return;
    if (spawn.reason === "not_enough_active_players") {
      setMessage("Yakinda aktif oyuncu yok. Hazine icin en az 2 oyuncu gerekli.");
    } else if (spawn.spawned) {
      setMessage("Yeni hazine spawn oldu!");
    }
  };

  const sendLocationToBackend = async (lat: number, lng: number, force = false) => {
    const now = Date.now();
    if (!force && now - lastLocationSentRef.current < LOCATION_SEND_INTERVAL_MS) return;
    lastLocationSentRef.current = now;
    try {
      const locationData = await api(
        "/game/location",
        { method: "POST", body: JSON.stringify({ lat, lng }) },
        token
      );
      setSpawnInfo(locationData.spawn || null);
      updateSpawnMessage(locationData.spawn);
    } catch (error: any) {
      setMessage(error.message || "Konum backend'e gonderilemedi.");
    }
  };

  const authenticate = async () => {
    if (!canAuth) {
      Alert.alert("Eksik Bilgi", "Username ve password gerekli.");
      return;
    }
    setLoading(true);
    setMessage("");
    try {
      if (mode === "register") {
        const registerData = await api("/auth/register", {
          method: "POST",
          body: JSON.stringify({ username: username.trim(), password }),
        });
        setMessage(registerData.message || "Kayit tamamlandi, giris yap.");
        setMode("login");
      } else {
        const loginData = await api("/auth/login", {
          method: "POST",
          body: JSON.stringify({ username: username.trim(), password }),
        });
        setToken(loginData.token);
        setMessage("Operasyon basarili. Oyuna hos geldin.");
      }
    } catch (error: any) {
      setMessage(error.message || "Islem basarisiz.");
    } finally {
      setLoading(false);
    }
  };

  const startLocationTracking = async () => {
    try {
      setLocationError("");
      const permission = await Location.requestForegroundPermissionsAsync();
      if (permission.status !== "granted") {
        setLocationPermissionState("denied");
        setLocationError(
          "Konum izni olmadan harita acilamaz. Ayarlardan konum iznini verip tekrar dene."
        );
        return;
      }

      setLocationPermissionState("granted");
      const current = await Location.getCurrentPositionAsync({
        accuracy: Location.Accuracy.Balanced,
      });
      const currentLat = current.coords.latitude;
      const currentLng = current.coords.longitude;
      setLocation({ lat: currentLat, lng: currentLng });
      await sendLocationToBackend(currentLat, currentLng, true);

      watchSubscriptionRef.current?.remove();
      watchSubscriptionRef.current = await Location.watchPositionAsync(
        {
          accuracy: Location.Accuracy.Balanced,
          timeInterval: 2500,
          distanceInterval: 2,
        },
        async (update) => {
          const nextLat = update.coords.latitude;
          const nextLng = update.coords.longitude;
          setLocation({ lat: nextLat, lng: nextLng });
          await sendLocationToBackend(nextLat, nextLng);
        }
      );
    } catch (error: any) {
      setLocationPermissionState("error");
      setLocationError(error.message || "Konum servisi baslatilamadi.");
    }
  };

  const checkTreasure = async () => {
    setLoading(true);
    setMessage("");
    try {
      const treasureData = await api("/game/treasure", {}, token);
      const activeTreasure = treasureData.activeTreasure || null;
      setTreasure(activeTreasure);
      setShowTreasurePanel(Boolean(activeTreasure));
      setMessage(activeTreasure ? "Treasure sinyali alindi." : "Aktif treasure yok. Av devam ediyor.");
    } catch (error: any) {
      setMessage(error.message || "Treasure kontrolu basarisiz.");
    } finally {
      setLoading(false);
    }
  };

  const collectTreasure = async () => {
    if (!canCollectTreasure) return;
    setCollecting(true);
    setMessage("");
    try {
      const collectData = await api("/game/treasure/collect", { method: "POST" }, token);
      setMessage(`${collectData.message} (+${collectData.reward} token)`);
      setTreasure(null);
      setShowTreasurePanel(false);
      await fetchWallet(true);
    } catch (error: any) {
      setMessage(error.message || "Collect basarisiz.");
    } finally {
      setCollecting(false);
    }
  };

  const fetchWallet = async (silent = false) => {
    if (!silent) setLoading(true);
    try {
      const walletData = await api("/wallet", {}, token);
      setWallet(walletData);
      if (!silent) setShowWalletPanel(true);
    } catch (error: any) {
      setMessage(error.message || "Wallet cekilemedi.");
    } finally {
      if (!silent) setLoading(false);
    }
  };

  const manualLocationUpdate = async () => {
    if (!location) {
      await startLocationTracking();
      return;
    }
    await sendLocationToBackend(location.lat, location.lng, true);
    setMessage("Konum manuel olarak guncellendi.");
  };

  const showComingSoon = (text = "Bu ozellik yakinda aktif olacak.") => {
    setMessage(text);
  };

  const addFriend = () => {
    const next = friendHandle.trim();
    if (!next) return;
    setFriends((prev) => (prev.includes(next) ? prev : [next, ...prev].slice(0, 10)));
    setFriendHandle("");
    showComingSoon("Arkadas sistemi yakinda aktif olacak.");
  };

  useEffect(() => {
    if (!token) return;
    startLocationTracking();
    checkTreasure();
    fetchWallet(true);
    return () => {
      watchSubscriptionRef.current?.remove();
      watchSubscriptionRef.current = null;
    };
  }, [token]);

  if (!token) {
    return (
      <SafeAreaView style={styles.authSafe}>
        <View style={styles.authPanel}>
          <Text style={styles.brand}>TREASURE HUNT</Text>
          <Text style={styles.subBrand}>Night Raid Protocol</Text>

          <View style={styles.authCard}>
            <Text style={styles.authTitle}>{mode === "login" ? "Login" : "Register"}</Text>
            <TextInput
              style={styles.input}
              placeholder="Username"
              placeholderTextColor={theme.muted}
              autoCapitalize="none"
              value={username}
              onChangeText={setUsername}
            />
            <TextInput
              style={styles.input}
              placeholder="Password"
              placeholderTextColor={theme.muted}
              secureTextEntry
              value={password}
              onChangeText={setPassword}
            />
            <TouchableOpacity style={styles.primaryButton} onPress={authenticate} disabled={loading}>
              {loading ? (
                <ActivityIndicator color="#042530" />
              ) : (
                <Text style={styles.primaryButtonText}>{mode.toUpperCase()}</Text>
              )}
            </TouchableOpacity>
            <TouchableOpacity
              style={styles.secondaryButton}
              onPress={() => setMode(mode === "login" ? "register" : "login")}
            >
              <Text style={styles.secondaryButtonText}>
                {mode === "login" ? "Hesabin yok mu? Register" : "Hesabin var mi? Login"}
              </Text>
            </TouchableOpacity>
          </View>

          {message ? <Text style={styles.footerMessage}>{message}</Text> : null}
        </View>
      </SafeAreaView>
    );
  }

  const walletBalance = wallet?.wallet_tokens ?? wallet?.walletTokens ?? 0;

  return (
    <SafeAreaView style={styles.safe}>
      <View style={styles.container}>
        {activeTab === "home" ? (
          <ScrollView
            style={styles.screenScroll}
            contentContainerStyle={styles.screenScrollContent}
            showsVerticalScrollIndicator={false}
          >
            <View style={styles.heroCard}>
              <Text style={styles.heroTitle}>Oyuncu Paneli</Text>
              <View style={styles.heroRow}>
                <View style={styles.heroPill}>
                  <Text style={styles.heroPillLabel}>Token</Text>
                  <Text style={styles.heroPillValue}>{walletBalance}</Text>
                </View>
                <View style={styles.heroPillAlt}>
                  <Text style={styles.heroPillLabel}>Durum</Text>
                  <Text style={styles.heroPillValue}>{playerStatus}</Text>
                </View>
              </View>
              <Text style={styles.heroSub}>
                Profil: <Text style={styles.heroSubStrong}>{username || "Oyuncu"}</Text>
              </Text>
            </View>

            <View style={styles.sectionCard}>
              <Text style={styles.sectionTitle}>Oyuncu Profili</Text>
              <View style={styles.profileRow}>
                <View style={styles.avatarCircle}>
                  <Text style={styles.avatarEmoji}>🧍‍♂️</Text>
                </View>
                <View style={{ flex: 1, gap: 4 }}>
                  <Text style={styles.profileName}>{username || "Oyuncu"}</Text>
                  <Text style={styles.profileMeta}>
                    Konum: {location ? `${location.lat.toFixed(5)}, ${location.lng.toFixed(5)}` : "Bekleniyor"}
                  </Text>
                  <Text style={styles.profileMeta}>Seviye: 7 (ornek)</Text>
                </View>
              </View>
            </View>

            <View style={styles.sectionCard}>
              <Text style={styles.sectionTitle}>Arkadas Ekle</Text>
              <View style={styles.friendRow}>
                <TextInput
                  value={friendHandle}
                  onChangeText={setFriendHandle}
                  placeholder="Kullanici adi"
                  placeholderTextColor={theme.muted}
                  style={styles.friendInput}
                  autoCapitalize="none"
                />
                <TouchableOpacity style={styles.friendAddButton} onPress={addFriend} activeOpacity={0.85}>
                  <Text style={styles.friendAddButtonText}>Ekle</Text>
                </TouchableOpacity>
              </View>
              <View style={styles.friendChips}>
                {friends.map((f) => (
                  <View key={f} style={styles.friendChip}>
                    <Text style={styles.friendChipText}>{f}</Text>
                  </View>
                ))}
              </View>
            </View>

            <View style={styles.sectionCard}>
              <Text style={styles.sectionTitle}>Envanterim</Text>
              <Text style={styles.sectionHint}>Sahip olunan dedektorler (ornek)</Text>
              <View style={{ gap: 10, marginTop: 10 }}>
                {ownedDetectors.map((d) => (
                  <View key={d.id} style={styles.inventoryItem}>
                    <View style={styles.inventoryIconWrap}>
                      <Text style={styles.inventoryIcon}>{d.icon}</Text>
                    </View>
                    <View style={{ flex: 1, gap: 2 }}>
                      <Text style={styles.inventoryName}>{d.name}</Text>
                      <Text style={styles.inventoryMeta}>{d.feature}</Text>
                    </View>
                    <TouchableOpacity
                      style={styles.inventoryEquipButton}
                      onPress={() => showComingSoon("Ekipman sistemi yakinda aktif olacak.")}
                      activeOpacity={0.85}
                    >
                      <Text style={styles.inventoryEquipText}>Kullan</Text>
                    </TouchableOpacity>
                  </View>
                ))}
              </View>
            </View>
          </ScrollView>
        ) : null}

        {activeTab === "maps" ? (
          <>
            {locationPermissionState === "denied" || locationPermissionState === "error" ? (
              <View style={styles.errorWrap}>
                <Text style={styles.errorTitle}>Harita Erisimi Gerekli</Text>
                <Text style={styles.errorText}>
                  {locationError || "Konum izni verilmeden oyun baslatilamiyor."}
                </Text>
                <TouchableOpacity style={styles.primaryButton} onPress={startLocationTracking}>
                  <Text style={styles.primaryButtonText}>Izin Iste</Text>
                </TouchableOpacity>
              </View>
            ) : !location ? (
              <View style={styles.loadingWrap}>
                <ActivityIndicator color={theme.neon} size="large" />
                <Text style={styles.loadingText}>GPS sinyali bekleniyor...</Text>
              </View>
            ) : (
              <MapView
                style={styles.fullMap}
                region={{
                  latitude: location.lat,
                  longitude: location.lng,
                  latitudeDelta: 0.008,
                  longitudeDelta: 0.008,
                }}
                showsUserLocation={false}
                followsUserLocation
                showsMyLocationButton
              >
                <Marker
                  coordinate={{ latitude: location.lat, longitude: location.lng }}
                  title="Oyuncu"
                  description="Canli konum"
                >
                  <View style={styles.playerMarkerGlow}>
                    <View style={styles.playerMarkerBody}>
                      <Text style={styles.playerEmoji}>🧍‍♂️</Text>
                    </View>
                  </View>
                </Marker>
                {treasure ? (
                  <Marker
                    coordinate={{ latitude: treasure.lat, longitude: treasure.lng }}
                    title="Treasure"
                    description="Altin sandik"
                    onPress={() => setShowTreasurePanel(true)}
                  >
                    <View style={styles.treasureMarker}>
                      <Text style={styles.treasureEmoji}>💰</Text>
                    </View>
                  </Marker>
                ) : null}
              </MapView>
            )}

            <View style={styles.mapsTokenHud}>
              <Text style={styles.mapsTokenHudText}>🪙 {walletBalance}</Text>
            </View>

            <View style={styles.floatingActions}>
              <TouchableOpacity style={styles.actionButton} onPress={manualLocationUpdate} disabled={loading}>
                <Text style={styles.actionText}>Konum Guncelle</Text>
              </TouchableOpacity>
              <TouchableOpacity style={styles.actionButtonGold} onPress={checkTreasure} disabled={loading}>
                <Text style={styles.actionTextGold}>Treasure Kontrol</Text>
              </TouchableOpacity>
              <TouchableOpacity style={styles.actionButton} onPress={() => fetchWallet()}>
                <Text style={styles.actionText}>Wallet</Text>
              </TouchableOpacity>
            </View>

            <View style={styles.bottomPanel}>
              <Text style={styles.bottomTitle}>Treasure Control</Text>
              <Text style={styles.bottomText}>Spawn: {spawnInfo?.spawned ? "Aktif" : "Bekleniyor"}</Text>
              <Text style={styles.bottomText}>Tip: {treasure?.type || "Yok"}</Text>
              <Text style={styles.bottomText}>
                Mesafe:{" "}
                {typeof treasureDistance === "number" ? `${Math.round(treasureDistance)} m` : "-"}
              </Text>

              {treasure ? (
                <TouchableOpacity
                  style={[
                    styles.collectButton,
                    (!canCollectTreasure || collecting || loading) && styles.disabledButton,
                  ]}
                  onPress={collectTreasure}
                  disabled={!canCollectTreasure || collecting || loading}
                >
                  {collecting ? (
                    <ActivityIndicator color="#1A2A00" />
                  ) : (
                    <Text style={styles.collectText}>
                      {canCollectTreasure ? "Collect Treasure" : "Collect icin 50m yakina gel"}
                    </Text>
                  )}
                </TouchableOpacity>
              ) : (
                <Text style={styles.noTreasureText}>Aktif treasure yok. Radar taramasi suruyor...</Text>
              )}

              {showTreasurePanel && treasure ? (
                <View style={styles.treasureInfoPanel}>
                  <Text style={styles.treasureInfoTitle}>Treasure Detayi</Text>
                  <Text style={styles.treasureInfoText}>ID: {treasure.id}</Text>
                  <Text style={styles.treasureInfoText}>
                    Konum: {treasure.lat.toFixed(5)}, {treasure.lng.toFixed(5)}
                  </Text>
                </View>
              ) : null}
            </View>
          </>
        ) : null}

        {activeTab === "shop" ? (
          <View style={styles.shopScreenWrap}>
            <ScrollView
              style={styles.screenScroll}
              contentContainerStyle={styles.shopScrollContentBig}
              showsVerticalScrollIndicator={false}
            >
              <TouchableOpacity
                style={styles.tokenBuyCard}
                onPress={() => setShowTokenShop(true)}
                activeOpacity={0.88}
              >
                <View style={{ gap: 3 }}>
                  <Text style={styles.tokenBuyTitle}>Token Satin Al</Text>
                  <Text style={styles.tokenBuySub}>Paket sec (ornek)</Text>
                </View>
                <Text style={styles.tokenBuyArrow}>➜</Text>
              </TouchableOpacity>

              <Text style={styles.shopListTitle}>Dedektorler</Text>
              <Text style={styles.shopListHint}>Ucuzdan pahaliya sirali</Text>

              <View style={{ gap: 10, marginTop: 10 }}>
                {shopDetectors.map((d) => (
                  <View key={d.id} style={styles.shopDetectorCard}>
                    <View style={styles.shopDetectorTop}>
                      <View style={styles.shopDetectorIconWrap}>
                        <Text style={styles.shopDetectorIcon}>{d.icon}</Text>
                      </View>
                      <View style={{ flex: 1, gap: 3 }}>
                        <Text style={styles.shopDetectorName}>{d.name}</Text>
                        <Text style={styles.shopDetectorDesc}>{d.description}</Text>
                        <View style={styles.shopStatsRow}>
                          <View style={styles.shopStatPill}>
                            <Text style={styles.shopStatLabel}>Menzil</Text>
                            <Text style={styles.shopStatValue}>{d.range}</Text>
                          </View>
                          <View style={styles.shopStatPillAlt}>
                            <Text style={styles.shopStatLabel}>Kazi</Text>
                            <Text style={styles.shopStatValue}>{d.digSpeed}</Text>
                          </View>
                        </View>
                      </View>
                    </View>
                    <View style={styles.shopDetectorBottom}>
                      <Text style={styles.shopDetectorPrice}>{d.price} token</Text>
                      <TouchableOpacity
                        style={styles.buyButton}
                        onPress={() => showComingSoon()}
                        activeOpacity={0.85}
                      >
                        <Text style={styles.buyButtonText}>Satin Al</Text>
                      </TouchableOpacity>
                    </View>
                  </View>
                ))}
              </View>
            </ScrollView>

            <Modal
              visible={showTokenShop}
              transparent
              animationType="slide"
              onRequestClose={() => setShowTokenShop(false)}
            >
              <View style={styles.shopOverlay}>
                <View style={styles.shopSheet}>
                  <View style={styles.shopHeaderRow}>
                    <Text style={styles.shopTitle}>Token Satin Al</Text>
                    <TouchableOpacity style={styles.shopCloseButton} onPress={() => setShowTokenShop(false)}>
                      <Text style={styles.shopCloseText}>Kapat</Text>
                    </TouchableOpacity>
                  </View>

                  <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={styles.shopScrollContent}>
                    {tokenPacks.map((p) => (
                      <View key={p.id} style={styles.packCard}>
                        <View style={{ gap: 4 }}>
                          <Text style={styles.packTitle}>🪙 {p.amount} Token</Text>
                          <Text style={styles.packPrice}>
                            {p.amount} Token - {p.priceText}
                          </Text>
                        </View>
                        <TouchableOpacity
                          style={styles.packBuyButton}
                          onPress={() => {
                            setShowTokenShop(false);
                            showComingSoon("Satin alma sistemi yakinda aktif olacak.");
                          }}
                          activeOpacity={0.85}
                        >
                          <Text style={styles.packBuyText}>Satin Al</Text>
                        </TouchableOpacity>
                      </View>
                    ))}
                  </ScrollView>
                </View>
              </View>
            </Modal>
          </View>
        ) : null}

        {message ? <Text style={styles.liveMessage}>{message}</Text> : null}

        <View style={styles.gameTabBar}>
          <TouchableOpacity
            style={[styles.gameTab, activeTab === "home" && styles.gameTabActive]}
            onPress={() => setActiveTab("home")}
            activeOpacity={0.88}
          >
            <Text style={[styles.gameTabIcon, activeTab === "home" && styles.gameTabIconActive]}>🏠</Text>
            <Text style={[styles.gameTabLabel, activeTab === "home" && styles.gameTabLabelActive]}>Home</Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={[styles.gameTab, activeTab === "maps" && styles.gameTabActive]}
            onPress={() => setActiveTab("maps")}
            activeOpacity={0.88}
          >
            <Text style={[styles.gameTabIcon, activeTab === "maps" && styles.gameTabIconActive]}>🗺️</Text>
            <Text style={[styles.gameTabLabel, activeTab === "maps" && styles.gameTabLabelActive]}>Maps</Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={[styles.gameTab, activeTab === "shop" && styles.gameTabActive]}
            onPress={() => setActiveTab("shop")}
            activeOpacity={0.88}
          >
            <Text style={[styles.gameTabIcon, activeTab === "shop" && styles.gameTabIconActive]}>🛒</Text>
            <Text style={[styles.gameTabLabel, activeTab === "shop" && styles.gameTabLabelActive]}>Shop</Text>
          </TouchableOpacity>
        </View>
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: theme.bg },
  container: { flex: 1, backgroundColor: theme.bg },
  fullMap: { ...StyleSheet.absoluteFillObject },
  screenScroll: { flex: 1 },
  screenScrollContent: { paddingTop: 16, paddingBottom: 110, paddingHorizontal: 14, gap: 12 },
  shopScrollContentBig: { paddingTop: 16, paddingBottom: 110, paddingHorizontal: 14 },
  mapsTokenHud: {
    position: "absolute",
    top: 14,
    right: 14,
    backgroundColor: "rgba(22, 38, 70, 0.92)",
    borderRadius: 14,
    borderWidth: 1,
    borderColor: "#7BA5ED",
    paddingHorizontal: 10,
    paddingVertical: 7,
    shadowColor: "#000",
    shadowOpacity: 0.25,
    shadowRadius: 10,
    shadowOffset: { width: 0, height: 4 },
    elevation: 10,
    zIndex: 30,
  },
  mapsTokenHudText: { color: theme.gold, fontWeight: "900" },
  heroCard: {
    borderRadius: 20,
    borderWidth: 1,
    borderColor: "#6C93D4",
    backgroundColor: "rgba(22, 38, 70, 0.92)",
    padding: 14,
    shadowColor: "#000",
    shadowOpacity: 0.25,
    shadowRadius: 14,
    shadowOffset: { width: 0, height: 8 },
    elevation: 9,
  },
  heroTitle: { color: theme.gold, fontWeight: "900", fontSize: 18, marginBottom: 10 },
  heroRow: { flexDirection: "row", gap: 10 },
  heroPill: {
    flex: 1,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: "rgba(86, 230, 255, 0.9)",
    backgroundColor: "rgba(36, 62, 108, 0.72)",
    padding: 10,
  },
  heroPillAlt: {
    flex: 1,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: "rgba(255, 214, 107, 0.9)",
    backgroundColor: "rgba(73, 58, 20, 0.35)",
    padding: 10,
  },
  heroPillLabel: { color: "#C7D7F7", fontSize: 12, fontWeight: "700" },
  heroPillValue: { color: theme.text, fontSize: 18, fontWeight: "900", marginTop: 4 },
  heroSub: { color: "#C7D7F7", marginTop: 10, fontWeight: "700" },
  heroSubStrong: { color: theme.neon, fontWeight: "900" },
  sectionCard: {
    borderRadius: 18,
    borderWidth: 1,
    borderColor: "#5D7FB8",
    backgroundColor: "rgba(30, 49, 86, 0.92)",
    padding: 14,
  },
  sectionTitle: { color: theme.text, fontSize: 16, fontWeight: "900" },
  sectionHint: { color: "#C7D7F7", marginTop: 4, fontSize: 12, fontWeight: "700" },
  profileRow: { flexDirection: "row", gap: 12, marginTop: 12, alignItems: "center" },
  avatarCircle: {
    width: 54,
    height: 54,
    borderRadius: 27,
    borderWidth: 1,
    borderColor: "#8BFBFF",
    backgroundColor: "rgba(17, 35, 63, 0.9)",
    alignItems: "center",
    justifyContent: "center",
  },
  avatarEmoji: { fontSize: 22 },
  profileName: { color: theme.gold, fontWeight: "900", fontSize: 16 },
  profileMeta: { color: "#C7D7F7", fontWeight: "700", fontSize: 12 },
  friendRow: { flexDirection: "row", gap: 10, marginTop: 12 },
  friendInput: {
    flex: 1,
    backgroundColor: "#253E69",
    borderRadius: 12,
    borderWidth: 1,
    borderColor: "#6E93CF",
    paddingHorizontal: 12,
    paddingVertical: 11,
    color: theme.text,
  },
  friendAddButton: {
    backgroundColor: theme.neon,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: "#A3F2FF",
    paddingHorizontal: 14,
    alignItems: "center",
    justifyContent: "center",
  },
  friendAddButtonText: { color: "#0A2A37", fontWeight: "900" },
  friendChips: { flexDirection: "row", flexWrap: "wrap", gap: 8, marginTop: 12 },
  friendChip: {
    backgroundColor: "rgba(36, 62, 108, 0.72)",
    borderRadius: 999,
    borderWidth: 1,
    borderColor: "#7BA5ED",
    paddingHorizontal: 10,
    paddingVertical: 6,
  },
  friendChipText: { color: theme.text, fontWeight: "800", fontSize: 12 },
  inventoryItem: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    borderRadius: 16,
    borderWidth: 1,
    borderColor: "#759CD9",
    backgroundColor: "rgba(38, 59, 98, 0.95)",
    padding: 12,
  },
  inventoryIconWrap: {
    width: 44,
    height: 44,
    borderRadius: 12,
    backgroundColor: "rgba(21, 37, 66, 0.96)",
    borderWidth: 1,
    borderColor: "#96B7EF",
    alignItems: "center",
    justifyContent: "center",
  },
  inventoryIcon: { fontSize: 22 },
  inventoryName: { color: theme.text, fontWeight: "900" },
  inventoryMeta: { color: "#C7D7F7", fontWeight: "700", fontSize: 12 },
  inventoryEquipButton: {
    backgroundColor: "rgba(73, 58, 20, 0.6)",
    borderRadius: 10,
    borderWidth: 1,
    borderColor: "#D2A84E",
    paddingHorizontal: 12,
    paddingVertical: 8,
  },
  inventoryEquipText: { color: theme.gold, fontWeight: "900", fontSize: 12 },
  shopScreenWrap: { flex: 1 },
  tokenBuyCard: {
    borderRadius: 18,
    borderWidth: 1,
    borderColor: "rgba(255, 214, 107, 0.9)",
    backgroundColor: "rgba(73, 58, 20, 0.35)",
    padding: 14,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  tokenBuyTitle: { color: theme.gold, fontWeight: "900", fontSize: 16 },
  tokenBuySub: { color: "#F7E7BD", fontWeight: "700", fontSize: 12 },
  tokenBuyArrow: { color: theme.neon, fontWeight: "900", fontSize: 18 },
  shopListTitle: { color: theme.text, fontWeight: "900", fontSize: 16, marginTop: 14 },
  shopListHint: { color: "#C7D7F7", fontWeight: "700", fontSize: 12, marginTop: 4 },
  shopDetectorCard: {
    borderRadius: 18,
    borderWidth: 1,
    borderColor: "#759CD9",
    backgroundColor: "rgba(38, 59, 98, 0.95)",
    padding: 12,
  },
  shopDetectorTop: { flexDirection: "row", gap: 10, alignItems: "center" },
  shopDetectorIconWrap: {
    width: 50,
    height: 50,
    borderRadius: 14,
    backgroundColor: "rgba(21, 37, 66, 0.96)",
    borderWidth: 1,
    borderColor: "#96B7EF",
    alignItems: "center",
    justifyContent: "center",
  },
  shopDetectorIcon: { fontSize: 24 },
  shopDetectorName: { color: theme.text, fontWeight: "900", fontSize: 15 },
  shopDetectorDesc: { color: "#C7D7F7", fontWeight: "700", fontSize: 12 },
  shopStatsRow: { flexDirection: "row", gap: 8, marginTop: 6 },
  shopStatPill: {
    borderRadius: 12,
    borderWidth: 1,
    borderColor: "rgba(86, 230, 255, 0.8)",
    backgroundColor: "rgba(36, 62, 108, 0.72)",
    paddingHorizontal: 10,
    paddingVertical: 7,
  },
  shopStatPillAlt: {
    borderRadius: 12,
    borderWidth: 1,
    borderColor: "rgba(255, 214, 107, 0.75)",
    backgroundColor: "rgba(73, 58, 20, 0.35)",
    paddingHorizontal: 10,
    paddingVertical: 7,
  },
  shopStatLabel: { color: "#C7D7F7", fontWeight: "800", fontSize: 10 },
  shopStatValue: { color: theme.text, fontWeight: "900", marginTop: 2, fontSize: 12 },
  shopDetectorBottom: {
    marginTop: 10,
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
  },
  shopDetectorPrice: { color: theme.gold, fontWeight: "900", fontSize: 14 },
  packCard: {
    borderRadius: 16,
    borderWidth: 1,
    borderColor: "#759CD9",
    backgroundColor: "rgba(38, 59, 98, 0.95)",
    padding: 12,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  packTitle: { color: theme.text, fontWeight: "900", fontSize: 14 },
  packPrice: { color: "#C7D7F7", fontWeight: "800", fontSize: 12 },
  packBuyButton: {
    backgroundColor: theme.neon,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: "#A3F2FF",
    paddingVertical: 8,
    paddingHorizontal: 12,
  },
  packBuyText: { color: "#0A2A37", fontWeight: "900", fontSize: 12 },
  gameTabBar: {
    position: "absolute",
    left: 14,
    right: 14,
    bottom: 14,
    height: 64,
    borderRadius: 22,
    borderWidth: 1,
    borderColor: "#6C93D4",
    backgroundColor: "rgba(22, 38, 70, 0.94)",
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 8,
    shadowColor: "#000",
    shadowOpacity: 0.35,
    shadowRadius: 16,
    shadowOffset: { width: 0, height: 10 },
    elevation: 20,
    zIndex: 90,
  },
  gameTab: {
    flex: 1,
    height: 52,
    borderRadius: 18,
    alignItems: "center",
    justifyContent: "center",
    gap: 3,
  },
  gameTabActive: {
    backgroundColor: "rgba(36, 62, 108, 0.72)",
    borderWidth: 1,
    borderColor: "rgba(86, 230, 255, 0.65)",
    shadowColor: "#56E6FF",
    shadowOpacity: 0.25,
    shadowRadius: 10,
    shadowOffset: { width: 0, height: 2 },
    elevation: 10,
  },
  gameTabIcon: { fontSize: 18, opacity: 0.85 },
  gameTabIconActive: { opacity: 1 },
  gameTabLabel: { color: "#C7D7F7", fontWeight: "800", fontSize: 12 },
  gameTabLabelActive: { color: theme.gold, fontWeight: "900" },
  hudTop: {
    position: "absolute",
    top: 10,
    left: 14,
    right: 14,
    backgroundColor: theme.hud,
    borderRadius: 16,
    borderWidth: 1,
    borderColor: "#4E6EA6",
    paddingHorizontal: 14,
    paddingVertical: 10,
    shadowColor: "#000",
    shadowOpacity: 0.35,
    shadowRadius: 14,
    shadowOffset: { width: 0, height: 8 },
    elevation: 9,
  },
  hudRow: { flexDirection: "row", justifyContent: "space-between", alignItems: "center" },
  hudTitle: { color: theme.gold, fontSize: 21, fontWeight: "800" },
  tokenText: { color: theme.neon, marginTop: 4, fontWeight: "700" },
  statusPill: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    backgroundColor: "#2A4373",
    borderRadius: 30,
    borderWidth: 1,
    borderColor: "#6286CA",
    paddingHorizontal: 10,
    paddingVertical: 5,
  },
  statusDot: { width: 8, height: 8, borderRadius: 10 },
  statusText: { color: theme.text, fontWeight: "700", fontSize: 12 },
  floatingActions: {
    position: "absolute",
    right: 14,
    top: 130,
    gap: 10,
    zIndex: 25,
  },
  actionButton: {
    backgroundColor: theme.panel,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: "#5C80BD",
    paddingVertical: 10,
    paddingHorizontal: 12,
    minWidth: 145,
  },
  actionButtonGold: {
    backgroundColor: "#493A14",
    borderRadius: 14,
    borderWidth: 1,
    borderColor: "#D2A84E",
    paddingVertical: 10,
    paddingHorizontal: 12,
    minWidth: 145,
  },
  actionText: { color: theme.neon, fontWeight: "700", textAlign: "center" },
  actionTextGold: { color: theme.gold, fontWeight: "700", textAlign: "center" },
  bottomPanel: {
    position: "absolute",
    left: 14,
    right: 14,
    bottom: 12,
    backgroundColor: theme.panel,
    borderRadius: 20,
    borderWidth: 1,
    borderColor: "#587BB8",
    padding: 14,
    shadowColor: "#000",
    shadowOpacity: 0.4,
    shadowRadius: 18,
    shadowOffset: { width: 0, height: 8 },
    elevation: 10,
    zIndex: 20,
  },
  shopOverlay: {
    flex: 1,
    backgroundColor: "rgba(5, 10, 22, 0.64)",
    justifyContent: "flex-end",
  },
  shopSheet: {
    maxHeight: "76%",
    borderTopLeftRadius: 24,
    borderTopRightRadius: 24,
    borderWidth: 1,
    borderColor: "#658FD2",
    backgroundColor: "rgba(22, 38, 70, 0.98)",
    paddingTop: 14,
    paddingHorizontal: 14,
    paddingBottom: 20,
  },
  shopHeaderRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    marginBottom: 10,
  },
  shopTitle: { color: theme.gold, fontSize: 20, fontWeight: "900" },
  shopCloseButton: {
    backgroundColor: "rgba(45, 69, 114, 0.95)",
    borderWidth: 1,
    borderColor: "#7AA6EC",
    borderRadius: 10,
    paddingHorizontal: 10,
    paddingVertical: 6,
  },
  shopCloseText: { color: theme.text, fontWeight: "700" },
  shopScrollContent: { paddingBottom: 8, gap: 10 },
  detectorCard: {
    borderRadius: 16,
    borderWidth: 1,
    borderColor: "#759CD9",
    backgroundColor: "rgba(38, 59, 98, 0.95)",
    padding: 12,
  },
  detectorCardTop: {
    flexDirection: "row",
    gap: 10,
    alignItems: "center",
  },
  detectorIconWrap: {
    width: 48,
    height: 48,
    borderRadius: 12,
    backgroundColor: "rgba(21, 37, 66, 0.96)",
    borderWidth: 1,
    borderColor: "#96B7EF",
    alignItems: "center",
    justifyContent: "center",
  },
  detectorIcon: { fontSize: 24 },
  detectorInfo: { flex: 1, gap: 2 },
  detectorName: { color: theme.text, fontWeight: "800", fontSize: 15 },
  detectorFeature: { color: "#C7D7F7", fontSize: 12 },
  detectorCardBottom: {
    marginTop: 10,
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
  },
  detectorPrice: { color: theme.gold, fontWeight: "900", fontSize: 14 },
  buyButton: {
    backgroundColor: "#55E3FF",
    borderRadius: 10,
    borderWidth: 1,
    borderColor: "#A3F2FF",
    paddingVertical: 7,
    paddingHorizontal: 14,
  },
  buyButtonText: { color: "#0A2A37", fontWeight: "900", fontSize: 12 },
  bottomTitle: { color: theme.text, fontSize: 17, fontWeight: "800", marginBottom: 6 },
  bottomText: { color: "#D7E2FF", marginBottom: 4 },
  collectButton: {
    backgroundColor: "#B5FF5E",
    borderRadius: 12,
    alignItems: "center",
    justifyContent: "center",
    paddingVertical: 12,
    marginTop: 8,
  },
  collectText: { color: "#1A2A00", fontWeight: "900" },
  disabledButton: { opacity: 0.55 },
  noTreasureText: { color: theme.gold, marginTop: 8, fontWeight: "700" },
  liveMessage: {
    position: "absolute",
    bottom: 94,
    left: 14,
    right: 14,
    color: theme.success,
    textAlign: "center",
    backgroundColor: "rgba(16, 45, 38, 0.9)",
    borderRadius: 12,
    borderWidth: 1,
    borderColor: "#3C8A74",
    paddingVertical: 8,
    paddingHorizontal: 10,
    fontWeight: "700",
  },
  playerMarkerGlow: {
    width: 52,
    height: 52,
    borderRadius: 26,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "rgba(86, 230, 255, 0.28)",
    borderWidth: 1.5,
    borderColor: "rgba(86, 230, 255, 0.95)",
  },
  playerMarkerBody: {
    width: 34,
    height: 34,
    borderRadius: 17,
    backgroundColor: "rgba(17, 35, 63, 0.9)",
    borderWidth: 1.5,
    borderColor: "#8BFBFF",
    alignItems: "center",
    justifyContent: "center",
  },
  playerEmoji: { fontSize: 18 },
  treasureMarker: {
    width: 44,
    height: 44,
    borderRadius: 22,
    backgroundColor: "rgba(65, 51, 17, 0.95)",
    borderWidth: 2.2,
    borderColor: theme.gold,
    alignItems: "center",
    justifyContent: "center",
    shadowColor: theme.gold,
    shadowOpacity: 0.45,
    shadowRadius: 8,
    shadowOffset: { width: 0, height: 2 },
    elevation: 8,
  },
  treasureEmoji: { fontSize: 22 },
  walletPanel: {
    position: "absolute",
    top: 295,
    right: 14,
    backgroundColor: "rgba(33, 53, 91, 0.96)",
    borderRadius: 14,
    borderWidth: 1,
    borderColor: "#6C93D4",
    padding: 12,
    minWidth: 145,
  },
  walletTitle: { color: theme.neon, fontWeight: "700" },
  walletValue: { color: theme.gold, fontWeight: "900", fontSize: 26, marginVertical: 4 },
  closeText: { color: theme.muted, fontSize: 12 },
  treasureInfoPanel: {
    marginTop: 10,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: "#AF8D3E",
    backgroundColor: "rgba(80, 62, 22, 0.9)",
    padding: 10,
  },
  treasureInfoTitle: { color: theme.gold, fontWeight: "800", marginBottom: 4 },
  treasureInfoText: { color: "#F7E7BD", fontSize: 12 },
  loadingWrap: { flex: 1, alignItems: "center", justifyContent: "center", gap: 10 },
  loadingText: { color: theme.neon, fontWeight: "700" },
  errorWrap: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 20,
    backgroundColor: theme.bg,
  },
  errorTitle: { color: theme.danger, fontWeight: "800", fontSize: 18, marginBottom: 8 },
  errorText: { color: "#FFC2D0", textAlign: "center", marginBottom: 14 },
  authSafe: { flex: 1, backgroundColor: theme.bg },
  authPanel: { flex: 1, justifyContent: "center", padding: 18 },
  brand: { color: theme.gold, fontSize: 34, fontWeight: "900", textAlign: "center" },
  subBrand: { color: theme.neon, textAlign: "center", marginBottom: 16 },
  authCard: {
    backgroundColor: theme.panel,
    borderRadius: 18,
    borderWidth: 1,
    borderColor: "#5D7FB8",
    padding: 14,
  },
  authTitle: { color: theme.text, fontSize: 20, fontWeight: "800", marginBottom: 10 },
  input: {
    backgroundColor: "#253E69",
    borderRadius: 12,
    borderWidth: 1,
    borderColor: "#6E93CF",
    paddingHorizontal: 12,
    paddingVertical: 11,
    color: theme.text,
    marginBottom: 10,
  },
  primaryButton: {
    backgroundColor: theme.neon,
    borderRadius: 12,
    alignItems: "center",
    justifyContent: "center",
    paddingVertical: 12,
    marginTop: 2,
    shadowColor: theme.neon,
    shadowOpacity: 0.35,
    shadowRadius: 8,
    shadowOffset: { width: 0, height: 2 },
    elevation: 6,
  },
  primaryButtonText: { color: "#022532", fontWeight: "900" },
  secondaryButton: {
    backgroundColor: "#35568F",
    borderRadius: 12,
    borderWidth: 1,
    borderColor: "#7BA5ED",
    alignItems: "center",
    justifyContent: "center",
    paddingVertical: 12,
    marginTop: 10,
  },
  secondaryButtonText: { color: theme.text, fontWeight: "700" },
  footerMessage: { color: theme.success, textAlign: "center", marginTop: 10, fontWeight: "700" },
});
