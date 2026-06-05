// ═══════════════════════════════════════════════════════════════
//   تطبيق تنبيه المنطقة — دوائر متعددة + بحث محسّن
// ═══════════════════════════════════════════════════════════════

import React, { useState, useEffect, useRef } from 'react';
import {
  View, Text, StyleSheet, TouchableOpacity, TextInput,
  Alert, Platform, ActivityIndicator, ScrollView,
  KeyboardAvoidingView, Switch, FlatList, SafeAreaView, Modal,
} from 'react-native';
import MapView, { Circle, Marker, Callout } from 'react-native-maps';
import Slider from '@react-native-community/slider';
import * as Location from 'expo-location';
import * as Notifications from 'expo-notifications';
import * as TaskManager from 'expo-task-manager';
import AsyncStorage from '@react-native-async-storage/async-storage';

// ─── Constants ────────────────────────────────────────────────
const GEOFENCE_TASK  = 'GEOFENCE_TASK';
const KEY_SETTINGS   = '@geo_settings_v2';
const KEY_HISTORY    = '@geo_history_v2';
const KEY_ZONES      = '@geo_zones_v2';
const KEY_LAST_NOTIF = '@geo_last_notif_v2';

// ألوان مختلفة لكل دائرة
const ZONE_COLORS = [
  '#4361ee', '#e63946', '#2dc653', '#ff9f1c',
  '#a855f7', '#06b6d4', '#f97316', '#ec4899',
];

const DEFAULTS = {
  entryMsg:   'وصلت إلى المنطقة المحددة 📍',
  exitMsg:    'غادرت المنطقة المحددة 🚶',
  quietOn:    false,
  quietStart: '23:00',
  quietEnd:   '07:00',
  antiSpam:   true,
  spamMins:   5,
};

const C = {
  bg:     '#1a1a2e',
  panel:  '#16213e',
  card:   '#0f3460',
  accent: '#4361ee',
  green:  '#2dc653',
  red:    '#e63946',
  border: '#1a4488',
  text:   '#ffffff',
  sub:    '#aaaaaa',
};

const newZoneTemplate = (colorIdx) => ({
  id:      Date.now().toString(),
  name:    '',
  center:  null,
  radius:  300,
  mode:    'both',
  color:   ZONE_COLORS[colorIdx % ZONE_COLORS.length],
  enabled: true,
  address: '',
});

// ─── Background Task ──────────────────────────────────────────
TaskManager.defineTask(GEOFENCE_TASK, async ({ data, error }) => {
  if (error || !data) return;
  const { eventType, region } = data;
  try {
    const raw = await AsyncStorage.getItem(KEY_SETTINGS);
    const s   = raw ? { ...DEFAULTS, ...JSON.parse(raw) } : DEFAULTS;
    const isEnter = eventType === Location.GeofencingEventType.Enter;

    // وقت الهدوء
    if (s.quietOn) {
      const now  = new Date();
      const nowM = now.getHours() * 60 + now.getMinutes();
      const [sh, sm] = s.quietStart.split(':').map(Number);
      const [eh, em] = s.quietEnd.split(':').map(Number);
      const sM = sh * 60 + sm, eM = eh * 60 + em;
      const inQ = sM > eM ? (nowM >= sM || nowM < eM) : (nowM >= sM && nowM < eM);
      if (inQ) return;
    }

    // منع التكرار
    if (s.antiSpam) {
      const lastRaw = await AsyncStorage.getItem(KEY_LAST_NOTIF);
      if (lastRaw) {
        const last = JSON.parse(lastRaw);
        const diffMin = (Date.now() - last.time) / 60000;
        if (diffMin < s.spamMins && last.type === (isEnter ? 'enter' : 'exit') && last.zone === region.identifier) return;
      }
    }

    // إرسال الإشعار
    await Notifications.scheduleNotificationAsync({
      content: {
        title: isEnter ? `📍 دخلت: ${region.identifier}` : `🚶 خرجت: ${region.identifier}`,
        body:  isEnter ? s.entryMsg : s.exitMsg,
        sound: true,
      },
      trigger: null,
    });

    await AsyncStorage.setItem(KEY_LAST_NOTIF, JSON.stringify({
      time: Date.now(), type: isEnter ? 'enter' : 'exit', zone: region.identifier,
    }));

    const hRaw = await AsyncStorage.getItem(KEY_HISTORY);
    const hist = hRaw ? JSON.parse(hRaw) : [];
    hist.unshift({
      id: Date.now().toString(),
      type: isEnter ? 'enter' : 'exit',
      msg:  isEnter ? s.entryMsg : s.exitMsg,
      zone: region.identifier,
      time: new Date().toLocaleString('ar-IQ'),
    });
    await AsyncStorage.setItem(KEY_HISTORY, JSON.stringify(hist.slice(0, 100)));
  } catch {}
});

Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowAlert: true, shouldPlaySound: true, shouldSetBadge: true,
  }),
});

// ─── Nominatim Search ─────────────────────────────────────────
async function searchNominatim(q) {
  const url = `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(q)}&format=json&limit=7&addressdetails=1&accept-language=ar`;
  const res  = await fetch(url, { headers: { 'User-Agent': 'GeofenceAlertApp/2.0' } });
  return res.json();
}

const PLACE_ICONS = {
  restaurant:'🍽️', cafe:'☕', fast_food:'🍔', hospital:'🏥',
  pharmacy:'💊', school:'🏫', university:'🎓', mosque:'🕌',
  church:'⛪', park:'🌳', hotel:'🏨', bank:'🏦', fuel:'⛽',
  supermarket:'🛒', mall:'🏬', cinema:'🎬', police:'🚓',
  airport:'✈️', bus_station:'🚌', city:'🏙️', town:'🏘️',
  village:'🏡', suburb:'🏢', road:'🛣️', default:'📍',
};

// ════════════════════════════════════════════════════════════════
//   Main App
// ════════════════════════════════════════════════════════════════
export default function App() {
  const mapRef = useRef(null);

  const [tab, setTab]             = useState('map');
  const [loading, setLoading]     = useState(true);
  const [userLoc, setUserLoc]     = useState(null);

  // ── مناطق متعددة ─────────────────────────────────────────────
  const [zones, setZones]         = useState([]);          // كل المناطق المحفوظة
  const [draft, setDraft]         = useState(null);        // المنطقة قيد الإنشاء
  const [editingId, setEditingId] = useState(null);        // منطقة قيد التعديل
  const [geoActive, setGeoActive] = useState(false);

  // ── بحث ──────────────────────────────────────────────────────
  const [searchOpen, setSearchOpen] = useState(false);
  const [query, setQuery]           = useState('');
  const [results, setResults]       = useState([]);
  const [searching, setSearching]   = useState(false);
  const searchTimer = useRef(null);

  // ── إعدادات وسجل ──────────────────────────────────────────────
  const [settings, setSettings]   = useState(DEFAULTS);
  const [history, setHistory]     = useState([]);

  // ─── Init ────────────────────────────────────────────────────
  useEffect(() => {
    (async () => {
      const { status: fg } = await Location.requestForegroundPermissionsAsync();
      if (fg !== 'granted') { setLoading(false); return; }
      await Location.requestBackgroundPermissionsAsync();
      await Notifications.requestPermissionsAsync();

      try {
        const loc = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Balanced });
        const ul  = { latitude: loc.coords.latitude, longitude: loc.coords.longitude };
        setUserLoc(ul);
        setTimeout(() => mapRef.current?.animateToRegion({ ...ul, latitudeDelta: 0.015, longitudeDelta: 0.015 }, 900), 600);
      } catch {}

      const sRaw = await AsyncStorage.getItem(KEY_SETTINGS);
      if (sRaw) setSettings(s => ({ ...s, ...JSON.parse(sRaw) }));

      const hRaw = await AsyncStorage.getItem(KEY_HISTORY);
      if (hRaw) setHistory(JSON.parse(hRaw));

      const zRaw = await AsyncStorage.getItem(KEY_ZONES);
      if (zRaw) setZones(JSON.parse(zRaw));

      setLoading(false);
    })();
  }, []);

  useEffect(() => {
    AsyncStorage.setItem(KEY_SETTINGS, JSON.stringify(settings));
  }, [settings]);

  // ─── حفظ المناطق ─────────────────────────────────────────────
  const saveZones = async (updated) => {
    setZones(updated);
    await AsyncStorage.setItem(KEY_ZONES, JSON.stringify(updated));
  };

  // ─── اختيار موقع من الخريطة ─────────────────────────────────
  const onMapPress = async (e) => {
    if (geoActive) return;
    const ll = e.nativeEvent.coordinate;

    if (editingId) {
      // تحديث موقع منطقة موجودة
      const updated = zones.map(z =>
        z.id === editingId ? { ...z, center: ll, address: 'جاري التحديد…' } : z
      );
      saveZones(updated);
      reverseGeoForZone(ll, editingId, updated);
    } else {
      // إنشاء draft جديد
      const d = { ...newZoneTemplate(zones.length), center: ll, address: 'جاري التحديد…' };
      setDraft(d);
      reverseGeoForDraft(ll);
    }
  };

  const reverseGeoForDraft = async (ll) => {
    try {
      const res = await Location.reverseGeocodeAsync(ll);
      if (res?.[0]) {
        const r = res[0];
        const addr = [r.name, r.street, r.district, r.city].filter(Boolean).join('، ');
        setDraft(d => d ? { ...d, address: addr || 'موقع غير معروف' } : d);
      }
    } catch { setDraft(d => d ? { ...d, address: 'تعذّر التحديد' } : d); }
  };

  const reverseGeoForZone = async (ll, id, zonesArr) => {
    try {
      const res = await Location.reverseGeocodeAsync(ll);
      if (res?.[0]) {
        const r = res[0];
        const addr = [r.name, r.street, r.district, r.city].filter(Boolean).join('، ');
        const upd = zonesArr.map(z => z.id === id ? { ...z, address: addr || 'موقع غير معروف' } : z);
        saveZones(upd);
      }
    } catch {}
  };

  // ─── حفظ Draft كمنطقة جديدة ──────────────────────────────────
  const saveDraft = () => {
    if (!draft?.center) {
      Alert.alert('تنبيه', '👆 اختر موقعاً على الخريطة أولاً');
      return;
    }
    const name = draft.name.trim() || `منطقة ${zones.length + 1}`;
    const newZone = { ...draft, name };
    const updated = [...zones, newZone];
    saveZones(updated);
    setDraft(null);
    Alert.alert('✅ تمت الإضافة', `تم إضافة "${name}" إلى قائمة مناطقك`);
  };

  // ─── تعديل منطقة ─────────────────────────────────────────────
  const editZone = (id) => {
    if (geoActive) return;
    setEditingId(id === editingId ? null : id);
    setDraft(null);
  };

  const updateZone = (id, key, value) => {
    const updated = zones.map(z => z.id === id ? { ...z, [key]: value } : z);
    saveZones(updated);
  };

  // ─── حذف منطقة ───────────────────────────────────────────────
  const deleteZone = (id) => {
    Alert.alert('حذف المنطقة', 'هل أنت متأكد؟', [
      { text: 'إلغاء', style: 'cancel' },
      {
        text: 'حذف', style: 'destructive',
        onPress: async () => {
          if (geoActive) {
            try { await Location.stopGeofencingAsync(GEOFENCE_TASK); } catch {}
            setGeoActive(false);
          }
          if (editingId === id) setEditingId(null);
          const updated = zones.filter(z => z.id !== id);
          saveZones(updated);
        },
      },
    ]);
  };

  // ─── تفعيل / إيقاف المراقبة ──────────────────────────────────
  const toggleGeo = async () => {
    const enabledZones = zones.filter(z => z.enabled && z.center);

    if (!geoActive && enabledZones.length === 0) {
      Alert.alert('تنبيه', 'أضف منطقة واحدة على الأقل وتأكد من تفعيلها');
      return;
    }

    if (geoActive) {
      try { await Location.stopGeofencingAsync(GEOFENCE_TASK); } catch {}
      setGeoActive(false);
      return;
    }

    try {
      const regions = enabledZones.map(z => ({
        identifier:    z.name,
        latitude:      z.center.latitude,
        longitude:     z.center.longitude,
        radius:        z.radius,
        notifyOnEnter: z.mode === 'enter' || z.mode === 'both',
        notifyOnExit:  z.mode === 'exit'  || z.mode === 'both',
      }));

      await Location.startGeofencingAsync(GEOFENCE_TASK, regions);
      setGeoActive(true);
      Alert.alert('✅ تم التفعيل', `${enabledZones.length} منطقة تُراقب الآن\n${enabledZones.map(z => `• ${z.name}`).join('\n')}`);
    } catch (err) {
      Alert.alert('خطأ', err.message);
    }
  };

  // ─── البحث ───────────────────────────────────────────────────
  const onQueryChange = (text) => {
    setQuery(text);
    if (searchTimer.current) clearTimeout(searchTimer.current);
    if (text.length < 2) { setResults([]); return; }
    searchTimer.current = setTimeout(async () => {
      setSearching(true);
      try {
        const res = await searchNominatim(text);
        setResults(res);
      } catch {
        Alert.alert('خطأ', 'تعذّر البحث، تحقق من الاتصال');
      }
      setSearching(false);
    }, 500);
  };

  const pickResult = (r) => {
    const ll   = { latitude: parseFloat(r.lat), longitude: parseFloat(r.lon) };
    const name = r.display_name.split(',')[0];
    const addr = r.display_name.split(',').slice(0, 3).join('، ');

    if (editingId) {
      const updated = zones.map(z => z.id === editingId ? { ...z, center: ll, address: addr } : z);
      saveZones(updated);
    } else {
      setDraft(d => ({
        ...(d || newZoneTemplate(zones.length)),
        center: ll,
        address: addr,
        name: d?.name || name,
      }));
    }

    mapRef.current?.animateToRegion({ ...ll, latitudeDelta: 0.012, longitudeDelta: 0.012 }, 900);
    setSearchOpen(false);
    setQuery('');
    setResults([]);
  };

  // ─── تنسيق القطر ─────────────────────────────────────────────
  const fmtR = (r) => r < 1000 ? `${r}م` : `${(r / 1000).toFixed(r % 1000 === 0 ? 0 : 1)}كم`;

  // ─── البانل السفلي — ماذا يُعرض؟ ─────────────────────────────
  const editingZone = zones.find(z => z.id === editingId);
  const panelZone   = draft || editingZone;
  const isDraft     = !!draft && !editingId;

  // ─── تحديث السجل ─────────────────────────────────────────────
  const refreshHistory = async () => {
    const raw = await AsyncStorage.getItem(KEY_HISTORY);
    setHistory(raw ? JSON.parse(raw) : []);
  };

  if (loading) {
    return (
      <View style={s.loader}>
        <ActivityIndicator size="large" color={C.accent} />
        <Text style={s.loaderTxt}>جاري التهيئة…</Text>
      </View>
    );
  }

  // ════════════════════════════════════════════════════════════
  return (
    <View style={s.root}>

      {/* ════ الخريطة ══════════════════════════════════════════ */}
      {tab === 'map' && (
        <View style={{ flex: 1 }}>
          <MapView
            ref={mapRef}
            style={s.map}
            showsUserLocation
            showsMyLocationButton={false}
            onPress={onMapPress}
            initialRegion={
              userLoc
                ? { ...userLoc, latitudeDelta: 0.015, longitudeDelta: 0.015 }
                : { latitude: 33.3152, longitude: 44.3661, latitudeDelta: 0.05, longitudeDelta: 0.05 }
            }
          >
            {/* ── دوائر المناطق المحفوظة ── */}
            {zones.map(z => z.center && (
              <React.Fragment key={z.id}>
                <Circle
                  center={z.center}
                  radius={z.radius}
                  strokeColor={z.color}
                  strokeWidth={editingId === z.id ? 3 : 2}
                  fillColor={z.color + (geoActive && z.enabled ? '30' : '18')}
                  lineDashPattern={geoActive && z.enabled ? undefined : [8, 4]}
                />
                <Marker
                  coordinate={z.center}
                  draggable={!geoActive}
                  pinColor={z.color}
                  onDragEnd={e => {
                    const ll  = e.nativeEvent.coordinate;
                    const upd = zones.map(zn => zn.id === z.id ? { ...zn, center: ll } : zn);
                    saveZones(upd);
                    reverseGeoForZone(ll, z.id, upd);
                  }}
                  onPress={() => editZone(z.id)}
                >
                  <Callout tooltip>
                    <View style={s.callout}>
                      <Text style={s.calloutName}>{z.name}</Text>
                      <Text style={s.calloutInfo}>{fmtR(z.radius)} · {z.mode === 'enter' ? 'دخول' : z.mode === 'exit' ? 'خروج' : 'كلاهما'}</Text>
                      <Text style={s.calloutAddr} numberOfLines={2}>{z.address}</Text>
                    </View>
                  </Callout>
                </Marker>
              </React.Fragment>
            ))}

            {/* ── دائرة Draft ── */}
            {draft?.center && (
              <React.Fragment>
                <Circle
                  center={draft.center}
                  radius={draft.radius}
                  strokeColor={draft.color}
                  strokeWidth={2.5}
                  fillColor={draft.color + '22'}
                  lineDashPattern={[6, 4]}
                />
                <Marker coordinate={draft.center} pinColor={draft.color} />
              </React.Fragment>
            )}
          </MapView>

          {/* ── شريط البحث (Google Maps style) ── */}
          <TouchableOpacity style={s.searchBar} onPress={() => setSearchOpen(true)} activeOpacity={0.85}>
            <Text style={s.searchBarIcon}>🔍</Text>
            <Text style={s.searchBarPlaceholder}>ابحث عن مكان أو عنوان…</Text>
            {geoActive && <View style={s.liveDot}><Text style={s.liveTxt}>LIVE</Text></View>}
          </TouchableOpacity>

          {/* ── أزرار عائمة ── */}
          <View style={s.fabCol}>
            {/* موقعي */}
            <TouchableOpacity style={s.fab} onPress={() => {
              if (userLoc) mapRef.current?.animateToRegion({ ...userLoc, latitudeDelta: 0.012, longitudeDelta: 0.012 }, 800);
            }}>
              <Text style={{ fontSize: 17 }}>📍</Text>
            </TouchableOpacity>

            {/* إضافة منطقة جديدة */}
            <TouchableOpacity
              style={[s.fab, s.fabAdd]}
              onPress={() => {
                if (geoActive) { Alert.alert('تنبيه', 'أوقف المراقبة أولاً لإضافة منطقة'); return; }
                setEditingId(null);
                setDraft(newZoneTemplate(zones.length));
                Alert.alert('إضافة منطقة', 'اضغط على الخريطة لتحديد موقع الدائرة الجديدة');
              }}
            >
              <Text style={{ fontSize: 22, color: '#fff', fontWeight: '700' }}>+</Text>
            </TouchableOpacity>
          </View>

          {/* ── لوحة التحكم ── */}
          <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
            <ScrollView style={s.panel} showsVerticalScrollIndicator={false} keyboardShouldPersistTaps="handled">

              {/* حالة بدون اختيار */}
              {!panelZone && zones.length === 0 && (
                <Text style={s.hint}>اضغط على <Text style={{ color: C.accent }}>+</Text> لإضافة أول منطقة تنبيه</Text>
              )}
              {!panelZone && zones.length > 0 && (
                <Text style={s.hint}>اضغط على <Text style={{ color: C.accent }}>+</Text> لإضافة منطقة جديدة أو اضغط على دائرة لتعديلها</Text>
              )}

              {/* ── تحرير منطقة (Draft أو موجودة) ── */}
              {panelZone && (
                <View style={[s.editCard, { borderColor: panelZone.color }]}>
                  {/* عنوان وإغلاق */}
                  <View style={s.editHeader}>
                    <View style={[s.colorDot, { backgroundColor: panelZone.color }]} />
                    <Text style={s.editTitle}>
                      {isDraft ? '🆕 منطقة جديدة' : `✏️ ${editingZone?.name || 'تعديل'}`}
                    </Text>
                    <TouchableOpacity onPress={() => { setDraft(null); setEditingId(null); }}>
                      <Text style={{ color: '#666', fontSize: 18 }}>✕</Text>
                    </TouchableOpacity>
                  </View>

                  {/* العنوان */}
                  {panelZone.center && (
                    <View style={s.addrCard}>
                      <Text style={s.addrTxt} numberOfLines={2}>{panelZone.address}</Text>
                    </View>
                  )}
                  {!panelZone.center && (
                    <Text style={[s.hint, { color: panelZone.color }]}>👆 اضغط على الخريطة لتحديد موقع الدائرة</Text>
                  )}

                  {/* الاسم */}
                  <TextInput
                    style={[s.input, { borderColor: panelZone.color + '55' }]}
                    placeholder="📌 اسم المنطقة"
                    placeholderTextColor="#555"
                    value={panelZone.name}
                    onChangeText={t => isDraft
                      ? setDraft(d => ({ ...d, name: t }))
                      : updateZone(editingId, 'name', t)
                    }
                    editable={!geoActive}
                  />

                  {/* وضع التنبيه */}
                  <Text style={s.secLabel}>:التنبيه عند</Text>
                  <View style={s.modeRow}>
                    {[
                      { k: 'enter', l: '📍 دخول' },
                      { k: 'exit',  l: '🚶 خروج' },
                      { k: 'both',  l: '↕️ كلاهما' },
                    ].map(({ k, l }) => (
                      <TouchableOpacity
                        key={k}
                        style={[s.modeBtn, panelZone.mode === k && { ...s.modeBtnOn, backgroundColor: panelZone.color }]}
                        onPress={() => {
                          if (geoActive) return;
                          isDraft ? setDraft(d => ({ ...d, mode: k })) : updateZone(editingId, 'mode', k);
                        }}
                      >
                        <Text style={[s.modeTxt, panelZone.mode === k && s.modeTxtOn]}>{l}</Text>
                      </TouchableOpacity>
                    ))}
                  </View>

                  {/* القطر */}
                  <View style={s.radiusRow}>
                    <Text style={[s.radiusVal, { color: panelZone.color }]}>{fmtR(panelZone.radius)}</Text>
                    <Text style={s.radiusLbl}>:القطر</Text>
                  </View>
                  <Slider
                    style={{ width: '100%' }}
                    minimumValue={100} maximumValue={5000} step={50}
                    value={panelZone.radius}
                    onValueChange={v => {
                      isDraft ? setDraft(d => ({ ...d, radius: v })) : updateZone(editingId, 'radius', v);
                    }}
                    minimumTrackTintColor={panelZone.color}
                    maximumTrackTintColor="#2a2a4a"
                    thumbTintColor={panelZone.color}
                    disabled={geoActive}
                  />
                  <View style={s.sliderEnds}>
                    <Text style={s.sliderEnd}>5 كم</Text>
                    <Text style={s.sliderEnd}>100 م</Text>
                  </View>

                  {/* أزرار سريعة */}
                  <View style={s.presetsRow}>
                    {[100, 300, 500, 1000, 2000, 5000].map(v => (
                      <TouchableOpacity
                        key={v}
                        style={[s.preset, panelZone.radius === v && { borderColor: panelZone.color, backgroundColor: panelZone.color + '20' }]}
                        onPress={() => {
                          if (geoActive) return;
                          isDraft ? setDraft(d => ({ ...d, radius: v })) : updateZone(editingId, 'radius', v);
                        }}
                      >
                        <Text style={[s.presetTxt, panelZone.radius === v && { color: panelZone.color, fontWeight: '700' }]}>
                          {fmtR(v)}
                        </Text>
                      </TouchableOpacity>
                    ))}
                  </View>

                  {/* زر حفظ / حذف */}
                  {isDraft ? (
                    <TouchableOpacity style={[s.saveBtn, { backgroundColor: panelZone.color }]} onPress={saveDraft}>
                      <Text style={s.saveBtnTxt}>✅ إضافة الدائرة للخريطة</Text>
                    </TouchableOpacity>
                  ) : (
                    <TouchableOpacity style={s.deleteZoneBtn} onPress={() => deleteZone(editingId)}>
                      <Text style={s.deleteZoneTxt}>🗑 حذف هذه المنطقة</Text>
                    </TouchableOpacity>
                  )}
                </View>
              )}

              {/* ── قائمة المناطق ── */}
              {zones.length > 0 && (
                <View style={{ marginTop: 12 }}>
                  <Text style={s.secLabel}>المناطق ({zones.length})</Text>
                  {zones.map(z => (
                    <View key={z.id} style={[s.zoneRow, editingId === z.id && { borderColor: z.color }]}>
                      <View style={[s.zoneColorBar, { backgroundColor: z.color }]} />
                      <TouchableOpacity style={{ flex: 1 }} onPress={() => {
                        editZone(z.id);
                        if (z.center) mapRef.current?.animateToRegion({ ...z.center, latitudeDelta: 0.01, longitudeDelta: 0.01 }, 700);
                      }}>
                        <Text style={s.zoneNameTxt}>{z.name}</Text>
                        <Text style={s.zoneSubTxt}>{fmtR(z.radius)} · {z.mode === 'enter' ? 'دخول' : z.mode === 'exit' ? 'خروج' : 'كلاهما'}</Text>
                      </TouchableOpacity>
                      <Switch
                        value={z.enabled}
                        onValueChange={v => { if (!geoActive) updateZone(z.id, 'enabled', v); }}
                        trackColor={{ false: '#333', true: z.color }}
                        thumbColor="#fff"
                        style={{ transform: [{ scaleX: 0.85 }, { scaleY: 0.85 }] }}
                      />
                    </View>
                  ))}
                </View>
              )}

              {/* ── زر تفعيل الكل ── */}
              {zones.length > 0 && (
                <>
                  <TouchableOpacity
                    style={[s.actBtn, geoActive && s.actBtnStop]}
                    onPress={toggleGeo}
                  >
                    <Text style={s.actBtnTxt}>
                      {geoActive
                        ? '⏹ إيقاف المراقبة'
                        : `▶️ تفعيل المراقبة (${zones.filter(z => z.enabled && z.center).length} منطقة)`
                      }
                    </Text>
                  </TouchableOpacity>
                  {geoActive && (
                    <Text style={s.activeStat}>
                      🟢 مراقبة {zones.filter(z => z.enabled).length} منطقة
                    </Text>
                  )}
                </>
              )}

              <View style={{ height: 20 }} />
            </ScrollView>
          </KeyboardAvoidingView>
        </View>
      )}

      {/* ════ السجل ════════════════════════════════════════════ */}
      {tab === 'history' && (
        <View style={{ flex: 1, backgroundColor: C.bg }}>
          <SafeAreaView>
            <View style={s.tabHeader}>
              <Text style={s.tabHeaderTxt}>📋 سجل الأحداث</Text>
              {history.length > 0 && (
                <TouchableOpacity onPress={() => Alert.alert('مسح', 'مسح كل السجل؟', [
                  { text: 'إلغاء', style: 'cancel' },
                  { text: 'مسح', style: 'destructive', onPress: async () => { setHistory([]); await AsyncStorage.removeItem(KEY_HISTORY); } },
                ])}>
                  <Text style={{ color: C.red, fontSize: 14 }}>مسح الكل</Text>
                </TouchableOpacity>
              )}
            </View>
          </SafeAreaView>
          <TouchableOpacity style={s.refreshBtn} onPress={refreshHistory}>
            <Text style={{ color: C.accent, fontSize: 14 }}>🔄 تحديث</Text>
          </TouchableOpacity>
          {history.length === 0 ? (
            <View style={s.emptyState}>
              <Text style={{ fontSize: 60, marginBottom: 16 }}>📭</Text>
              <Text style={s.emptyTxt}>لا توجد أحداث بعد</Text>
              <Text style={s.emptySub}>ستظهر هنا عند الدخول أو الخروج من مناطقك</Text>
            </View>
          ) : (
            <FlatList
              data={history}
              keyExtractor={i => i.id}
              contentContainerStyle={{ padding: 16 }}
              renderItem={({ item }) => (
                <View style={s.histItem}>
                  <Text style={{ fontSize: 26 }}>{item.type === 'enter' ? '📍' : '🚶'}</Text>
                  <View style={{ flex: 1 }}>
                    <Text style={s.histMsg}>{item.msg}</Text>
                    <Text style={s.histZone}>📌 {item.zone}</Text>
                    <Text style={s.histTime}>{item.time}</Text>
                  </View>
                </View>
              )}
            />
          )}
        </View>
      )}

      {/* ════ الإعدادات ════════════════════════════════════════ */}
      {tab === 'settings' && (
        <ScrollView style={{ flex: 1, backgroundColor: C.bg }} showsVerticalScrollIndicator={false}>
          <SafeAreaView>
            <View style={s.tabHeader}>
              <Text style={s.tabHeaderTxt}>⚙️ الإعدادات</Text>
            </View>
          </SafeAreaView>

          <View style={s.settSec}>
            <Text style={s.settSecTitle}>💬 رسائل الإشعار</Text>
            <Text style={s.settLbl}>رسالة الدخول</Text>
            <TextInput style={s.settInput} value={settings.entryMsg}
              onChangeText={t => setSettings(p => ({ ...p, entryMsg: t }))}
              placeholder="مثال: وصلت البيت ✅" placeholderTextColor="#555" />
            <Text style={s.settLbl}>رسالة الخروج</Text>
            <TextInput style={s.settInput} value={settings.exitMsg}
              onChangeText={t => setSettings(p => ({ ...p, exitMsg: t }))}
              placeholder="مثال: خرجت من الشغل 🚶" placeholderTextColor="#555" />
            <View style={s.previewBox}>
              <Text style={s.previewLabel}>معاينة:</Text>
              <Text style={s.previewTitle}>📍 دخلت: اسم المنطقة</Text>
              <Text style={s.previewBody}>{settings.entryMsg}</Text>
            </View>
          </View>

          <View style={s.settSec}>
            <Text style={s.settSecTitle}>🚫 منع تكرار الإشعار</Text>
            <View style={s.settRow}>
              <Text style={s.settRowTxt}>تفعيل</Text>
              <Switch value={settings.antiSpam}
                onValueChange={v => setSettings(p => ({ ...p, antiSpam: v }))}
                trackColor={{ false: '#333', true: C.accent }} thumbColor="#fff" />
            </View>
            {settings.antiSpam && (
              <>
                <Text style={s.settLbl}>فترة الهدوء: {settings.spamMins} دقيقة</Text>
                <Slider style={{ width: '100%' }} minimumValue={1} maximumValue={60} step={1}
                  value={settings.spamMins}
                  onValueChange={v => setSettings(p => ({ ...p, spamMins: Math.round(v) }))}
                  minimumTrackTintColor={C.accent} maximumTrackTintColor="#2a2a4a" thumbTintColor={C.accent} />
                <Text style={s.settHint}>لن تتكرر رسالة نفس النوع خلال {settings.spamMins} دقيقة</Text>
              </>
            )}
          </View>

          <View style={s.settSec}>
            <Text style={s.settSecTitle}>🌙 وقت الهدوء</Text>
            <View style={s.settRow}>
              <Text style={s.settRowTxt}>لا إشعارات في هذا الوقت</Text>
              <Switch value={settings.quietOn}
                onValueChange={v => setSettings(p => ({ ...p, quietOn: v }))}
                trackColor={{ false: '#333', true: C.accent }} thumbColor="#fff" />
            </View>
            {settings.quietOn && (
              <View style={s.quietRow}>
                <View style={{ flex: 1 }}>
                  <Text style={s.settLbl}>من</Text>
                  <TextInput style={s.timeInput} value={settings.quietStart}
                    onChangeText={t => setSettings(p => ({ ...p, quietStart: t }))}
                    placeholder="23:00" placeholderTextColor="#555"
                    keyboardType="numbers-and-punctuation" maxLength={5} textAlign="center" />
                </View>
                <Text style={{ color: C.sub, fontSize: 24, paddingTop: 24, paddingHorizontal: 8 }}>←</Text>
                <View style={{ flex: 1 }}>
                  <Text style={s.settLbl}>إلى</Text>
                  <TextInput style={s.timeInput} value={settings.quietEnd}
                    onChangeText={t => setSettings(p => ({ ...p, quietEnd: t }))}
                    placeholder="07:00" placeholderTextColor="#555"
                    keyboardType="numbers-and-punctuation" maxLength={5} textAlign="center" />
                </View>
              </View>
            )}
          </View>

          <View style={{ paddingHorizontal: 16, marginBottom: 40 }}>
            <TouchableOpacity style={s.resetBtn}
              onPress={() => Alert.alert('إعادة الضبط', 'إعادة الإعدادات للافتراضية؟', [
                { text: 'إلغاء', style: 'cancel' },
                { text: 'نعم', onPress: () => setSettings(DEFAULTS) },
              ])}>
              <Text style={s.resetBtnTxt}>🔄 إعادة الضبط الافتراضي</Text>
            </TouchableOpacity>
          </View>
        </ScrollView>
      )}

      {/* ════ شريط التبويبات ════════════════════════════════════ */}
      <View style={s.tabBar}>
        {[
          { k: 'map',      icon: '🗺️',  label: 'الخريطة'   },
          { k: 'history',  icon: '📋',  label: 'السجل'      },
          { k: 'settings', icon: '⚙️',  label: 'الإعدادات' },
        ].map(({ k, icon, label }) => (
          <TouchableOpacity key={k} style={s.tabItem} onPress={() => {
            setTab(k);
            if (k === 'history') refreshHistory();
          }}>
            <Text style={s.tabIcon}>{icon}</Text>
            <Text style={[s.tabLabel, tab === k && s.tabLabelOn]}>{label}</Text>
            {k === 'history' && history.length > 0 && (
              <View style={s.tabBadge}>
                <Text style={s.tabBadgeTxt}>{history.length > 99 ? '99+' : history.length}</Text>
              </View>
            )}
          </TouchableOpacity>
        ))}
      </View>

      {/* ════ Modal البحث ══════════════════════════════════════ */}
      <Modal visible={searchOpen} animationType="slide" presentationStyle="pageSheet" onRequestClose={() => setSearchOpen(false)}>
        <View style={s.searchModal}>
          <View style={s.searchModalHeader}>
            <Text style={s.searchModalTitle}>🔍 البحث عن مكان</Text>
            <TouchableOpacity onPress={() => { setSearchOpen(false); setQuery(''); setResults([]); }}>
              <Text style={{ color: C.accent, fontSize: 16 }}>إغلاق</Text>
            </TouchableOpacity>
          </View>

          <View style={s.searchInputWrap}>
            <TextInput
              style={s.searchModalInput}
              placeholder="اكتب اسم المكان أو العنوان…"
              placeholderTextColor="#888"
              value={query}
              onChangeText={onQueryChange}
              autoFocus
              returnKeyType="search"
            />
            {searching && <ActivityIndicator size="small" color={C.accent} style={{ position: 'absolute', left: 16, top: 14 }} />}
            {query.length > 0 && !searching && (
              <TouchableOpacity style={{ position: 'absolute', left: 16, top: 14 }} onPress={() => { setQuery(''); setResults([]); }}>
                <Text style={{ color: '#888', fontSize: 18 }}>✕</Text>
              </TouchableOpacity>
            )}
          </View>

          <FlatList
            data={results}
            keyExtractor={(_, i) => i.toString()}
            keyboardShouldPersistTaps="handled"
            renderItem={({ item }) => {
              const name = item.display_name.split(',')[0];
              const addr = item.display_name.split(',').slice(1, 3).join('، ');
              const icon = PLACE_ICONS[item.type] || PLACE_ICONS[item.class] || PLACE_ICONS.default;
              return (
                <TouchableOpacity style={s.searchResult} onPress={() => pickResult(item)}>
                  <Text style={s.srIcon}>{icon}</Text>
                  <View style={{ flex: 1 }}>
                    <Text style={s.srName}>{name}</Text>
                    <Text style={s.srAddr} numberOfLines={1}>{addr}</Text>
                  </View>
                </TouchableOpacity>
              );
            }}
            ListEmptyComponent={
              query.length >= 2 && !searching ? (
                <View style={{ alignItems: 'center', padding: 40 }}>
                  <Text style={{ fontSize: 40, marginBottom: 12 }}>🔍</Text>
                  <Text style={{ color: '#888' }}>لا توجد نتائج</Text>
                </View>
              ) : null
            }
          />
        </View>
      </Modal>

    </View>
  );
}

// ════════════════════════════════════════════════════════════════
const s = StyleSheet.create({
  root:     { flex: 1, backgroundColor: C.bg },
  loader:   { flex: 1, justifyContent: 'center', alignItems: 'center', backgroundColor: C.bg },
  loaderTxt:{ color: '#fff', marginTop: 14, fontSize: 16 },

  map: { flex: 1 },

  // شريط البحث (Google Maps style)
  searchBar: {
    position: 'absolute', top: 52, left: 12, right: 12, zIndex: 10,
    flexDirection: 'row', alignItems: 'center',
    backgroundColor: '#fff', borderRadius: 28,
    paddingHorizontal: 18, height: 50, gap: 10,
    shadowColor: '#000', shadowOpacity: 0.22, shadowRadius: 12, elevation: 7,
  },
  searchBarIcon:       { fontSize: 17 },
  searchBarPlaceholder:{ flex: 1, fontSize: 15, color: '#bbb', textAlign: 'right' },
  liveDot:  { backgroundColor: C.green, borderRadius: 10, paddingHorizontal: 7, paddingVertical: 2 },
  liveTxt:  { color: '#fff', fontSize: 9, fontWeight: '700' },

  // FABs
  fabCol: { position: 'absolute', right: 12, top: 116, gap: 10 },
  fab:    { width: 46, height: 46, backgroundColor: '#fff', borderRadius: 23, justifyContent: 'center', alignItems: 'center', shadowColor: '#000', shadowOpacity: 0.2, shadowRadius: 6, elevation: 4 },
  fabAdd: { backgroundColor: C.accent, shadowColor: C.accent, shadowOpacity: 0.5 },

  // Callout
  callout:     { backgroundColor: '#fff', borderRadius: 12, padding: 10, maxWidth: 180, borderWidth: 1, borderColor: '#eee' },
  calloutName: { fontWeight: '700', fontSize: 13, color: '#111', textAlign: 'right', marginBottom: 3 },
  calloutInfo: { fontSize: 12, color: C.accent, textAlign: 'right', marginBottom: 3 },
  calloutAddr: { fontSize: 11, color: '#888', textAlign: 'right' },

  // Panel
  panel: { backgroundColor: C.panel, borderTopLeftRadius: 24, borderTopRightRadius: 24, maxHeight: 380, paddingHorizontal: 14, paddingTop: 14 },

  editCard:  { borderWidth: 1.5, borderRadius: 16, padding: 14, marginBottom: 12 },
  editHeader:{ flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 10 },
  colorDot:  { width: 12, height: 12, borderRadius: 6 },
  editTitle: { flex: 1, color: '#fff', fontSize: 14, fontWeight: '700', textAlign: 'right' },

  addrCard: { backgroundColor: C.card, borderRadius: 11, padding: 10, marginBottom: 10 },
  addrTxt:  { color: '#ccc', fontSize: 12, textAlign: 'right', lineHeight: 18 },
  hint:     { color: '#666', textAlign: 'center', fontSize: 13, marginBottom: 10, lineHeight: 20 },

  input: { backgroundColor: C.card, color: '#fff', borderRadius: 11, padding: 11, fontSize: 14, textAlign: 'right', borderWidth: 1, borderColor: C.border, marginBottom: 10 },

  secLabel: { color: '#aaa', fontSize: 12, textAlign: 'right', marginBottom: 7 },

  modeRow:   { flexDirection: 'row', gap: 6, marginBottom: 12 },
  modeBtn:   { flex: 1, paddingVertical: 9, borderRadius: 11, backgroundColor: C.card, borderWidth: 1, borderColor: C.border, alignItems: 'center' },
  modeBtnOn: { borderColor: 'transparent' },
  modeTxt:   { color: '#666', fontSize: 12 },
  modeTxtOn: { color: '#fff', fontWeight: '700' },

  radiusRow: { flexDirection: 'row', justifyContent: 'space-between', marginBottom: 3 },
  radiusVal: { fontSize: 16, fontWeight: '700' },
  radiusLbl: { color: '#bbb', fontSize: 13 },
  sliderEnds:{ flexDirection: 'row', justifyContent: 'space-between', marginBottom: 8 },
  sliderEnd: { color: '#555', fontSize: 10 },

  presetsRow: { flexDirection: 'row', gap: 5, marginBottom: 12, flexWrap: 'wrap' },
  preset:     { paddingVertical: 6, paddingHorizontal: 8, borderRadius: 9, backgroundColor: C.card, borderWidth: 1, borderColor: C.border },
  presetTxt:  { color: '#666', fontSize: 11 },

  saveBtn:    { borderRadius: 13, paddingVertical: 13, alignItems: 'center', marginBottom: 4 },
  saveBtnTxt: { color: '#fff', fontSize: 14, fontWeight: '700' },

  deleteZoneBtn: { borderWidth: 1, borderColor: C.red + '88', borderRadius: 11, paddingVertical: 10, alignItems: 'center' },
  deleteZoneTxt: { color: C.red, fontSize: 13 },

  zoneRow:     { flexDirection: 'row', alignItems: 'center', backgroundColor: C.card, borderRadius: 12, marginBottom: 7, borderWidth: 1.5, borderColor: 'transparent', overflow: 'hidden' },
  zoneColorBar:{ width: 5, alignSelf: 'stretch' },
  zoneNameTxt: { color: '#fff', fontSize: 13, fontWeight: '600', textAlign: 'right', paddingTop: 10, paddingRight: 10 },
  zoneSubTxt:  { color: '#888', fontSize: 11, textAlign: 'right', paddingBottom: 10, paddingRight: 10 },

  actBtn:     { backgroundColor: C.accent, borderRadius: 16, paddingVertical: 15, alignItems: 'center', marginTop: 10, marginBottom: 8, shadowColor: C.accent, shadowOpacity: 0.4, shadowRadius: 10, elevation: 4 },
  actBtnStop: { backgroundColor: C.red, shadowColor: C.red },
  actBtnTxt:  { color: '#fff', fontSize: 15, fontWeight: '700' },
  activeStat: { color: C.green, textAlign: 'center', fontSize: 13, fontWeight: '600', marginBottom: 6 },

  tabBar:     { flexDirection: 'row', backgroundColor: C.panel, borderTopWidth: 1, borderTopColor: C.border, paddingBottom: Platform.OS === 'ios' ? 22 : 8, paddingTop: 8 },
  tabItem:    { flex: 1, alignItems: 'center', gap: 2, position: 'relative' },
  tabIcon:    { fontSize: 22 },
  tabLabel:   { color: '#555', fontSize: 11 },
  tabLabelOn: { color: C.accent, fontWeight: '700' },
  tabBadge:   { position: 'absolute', top: -2, right: '18%', backgroundColor: C.red, borderRadius: 8, minWidth: 16, height: 16, justifyContent: 'center', alignItems: 'center', paddingHorizontal: 3 },
  tabBadgeTxt:{ color: '#fff', fontSize: 9, fontWeight: '700' },

  tabHeader:   { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', padding: 16, paddingTop: 20 },
  tabHeaderTxt:{ color: '#fff', fontSize: 18, fontWeight: '700' },
  refreshBtn:  { alignItems: 'flex-end', paddingHorizontal: 16, marginBottom: 6 },
  emptyState:  { flex: 1, justifyContent: 'center', alignItems: 'center', padding: 40 },
  emptyTxt:    { color: '#fff', fontSize: 18, fontWeight: '700', marginBottom: 8 },
  emptySub:    { color: '#666', fontSize: 14, textAlign: 'center', lineHeight: 22 },
  histItem:    { flexDirection: 'row', gap: 14, backgroundColor: C.card, borderRadius: 14, padding: 14, marginBottom: 10 },
  histMsg:     { color: '#fff', fontSize: 14, fontWeight: '600', textAlign: 'right', marginBottom: 4 },
  histZone:    { color: '#888', fontSize: 12, textAlign: 'right', marginBottom: 3 },
  histTime:    { color: '#555', fontSize: 11, textAlign: 'right' },

  settSec:      { backgroundColor: C.panel, margin: 12, marginBottom: 0, borderRadius: 18, padding: 16, borderWidth: 1, borderColor: C.border },
  settSecTitle: { color: '#fff', fontSize: 15, fontWeight: '700', marginBottom: 14, textAlign: 'right' },
  settLbl:      { color: '#aaa', fontSize: 13, textAlign: 'right', marginBottom: 6 },
  settInput:    { backgroundColor: C.card, color: '#fff', borderRadius: 12, padding: 13, fontSize: 14, textAlign: 'right', borderWidth: 1, borderColor: C.border, marginBottom: 12 },
  settRow:      { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 },
  settRowTxt:   { color: '#ccc', fontSize: 14 },
  settHint:     { color: '#666', fontSize: 12, textAlign: 'right', marginBottom: 8 },
  previewBox:   { backgroundColor: '#0a1a30', borderRadius: 12, padding: 12, borderWidth: 1, borderColor: '#1a3a60' },
  previewLabel: { color: '#666', fontSize: 11, textAlign: 'right', marginBottom: 6 },
  previewTitle: { color: '#fff', fontSize: 14, fontWeight: '700', textAlign: 'right', marginBottom: 4 },
  previewBody:  { color: '#ccc', fontSize: 13, textAlign: 'right' },
  quietRow:     { flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 8 },
  timeInput:    { backgroundColor: C.card, color: '#fff', borderRadius: 11, padding: 13, fontSize: 18, borderWidth: 1, borderColor: C.border, textAlign: 'center' },
  resetBtn:     { borderWidth: 1, borderColor: C.red, borderRadius: 14, padding: 14, alignItems: 'center', marginTop: 16 },
  resetBtnTxt:  { color: C.red, fontSize: 14, fontWeight: '600' },

  // Search Modal
  searchModal:      { flex: 1, backgroundColor: C.bg },
  searchModalHeader:{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', padding: 20, paddingTop: 24, borderBottomWidth: 1, borderBottomColor: C.border },
  searchModalTitle: { color: '#fff', fontSize: 17, fontWeight: '700' },
  searchInputWrap:  { margin: 16, position: 'relative' },
  searchModalInput: { backgroundColor: C.card, color: '#fff', borderRadius: 14, padding: 14, paddingLeft: 46, fontSize: 16, textAlign: 'right', borderWidth: 1, borderColor: C.border },
  searchResult:     { flexDirection: 'row', alignItems: 'center', gap: 14, padding: 16, borderBottomWidth: 1, borderBottomColor: C.border },
  srIcon:           { fontSize: 22, width: 30, textAlign: 'center' },
  srName:           { color: '#fff', fontSize: 15, fontWeight: '600', textAlign: 'right', marginBottom: 3 },
  srAddr:           { color: '#888', fontSize: 12, textAlign: 'right' },
});
