import { Feather } from "@expo/vector-icons";
import { useCallback, useEffect, useMemo, useState } from "react";
import { ActivityIndicator, Alert, KeyboardAvoidingView, Modal, Platform, Pressable, SafeAreaView, ScrollView, Share, StyleSheet, Text, TextInput, View } from "react-native";
import Svg, { Circle } from "react-native-svg";
import { storage } from "@/src/utils/storage";
import { authorizedRequest, forgotPassword, resetPassword, restoreSession, signIn, signOut, signUp, User } from "@/src/auth";

type TxType = "expense" | "income" | "savings";
type Transaction = { id: string; type: TxType; amount: number; category: string; note?: string; date: string; created_at: string };
type Budget = { id: string; category: string; monthly_limit: number; updated_at: string };
type SavingsGoal = { id: string; target: number; updated_at: string };
const COLORS = { bg: "#F9F8F6", ink: "#1C1C1E", muted: "#777773", green: "#4A6B5D", pale: "#E5EBE8", card: "#FFFFFF", line: "#E5E4E0", red: "#B23B3B", gold: "#C28E38", negBalance: "#FF8A8A" };
const TRANSFERRED_CATEGORIES = ["Food", "Transport", "Bills", "Rent", "Shopping", "Health", "Travel", "Other"];
const RECEIVED_CATEGORIES = ["Salary", "Interest", "Trading", "Other"];
const SAVINGS_CATEGORIES = ["Emergency Fund", "Goal", "Investment", "Retirement", "Other"];
const categoriesFor = (type: TxType) => (type === "expense" ? TRANSFERRED_CATEGORIES : type === "income" ? RECEIVED_CATEGORIES : SAVINGS_CATEGORIES);
const money = (n: number) => `₹${Math.abs(n).toLocaleString("en-IN", { maximumFractionDigits: 0 })}`;
const monthLabel = (ym: string) => { const [y, m] = ym.split("-").map(Number); return new Date(y, m - 1, 1).toLocaleDateString("en-IN", { month: "long", year: "numeric" }); };
const nowMonth = () => new Date().toISOString().slice(0, 7);
const shiftMonth = (ym: string, delta: number) => { const [y, m] = ym.split("-").map(Number); const d = new Date(y, m - 1 + delta, 1); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`; };

export default function Index() {
  const [user, setUser] = useState<User | null>(null);
  const [checking, setChecking] = useState(true);
  useEffect(() => { restoreSession().then(setUser).finally(() => setChecking(false)); }, []);
  if (checking) return <SafeAreaView style={styles.safe}><ActivityIndicator color={COLORS.green} style={styles.loader} /></SafeAreaView>;
  if (!user) return <AuthScreen onAuthenticated={setUser} />;
  return <Dashboard user={user} onSignedOut={() => setUser(null)} />;
}

function Dashboard({ user, onSignedOut }: { user: User; onSignedOut: () => void }) {
  const [transactions, setTransactions] = useState<Transaction[]>([]);
  const [budgets, setBudgets] = useState<Budget[]>([]);
  const [loading, setLoading] = useState(true);
  const [tab, setTab] = useState("Overview");
  const [month, setMonth] = useState(nowMonth());
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [changePwOpen, setChangePwOpen] = useState(false);
  const [editorOpen, setEditorOpen] = useState(false);
  const [editing, setEditing] = useState<Transaction | null>(null);
  const [actionsFor, setActionsFor] = useState<Transaction | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<Transaction | null>(null);
  const [budgetSheet, setBudgetSheet] = useState<string | null>(null);
  const [savingsGoal, setSavingsGoal] = useState<SavingsGoal | null>(null);
  const [goalSheetOpen, setGoalSheetOpen] = useState(false);
  const [form, setForm] = useState({ amount: "", category: "Food", note: "", type: "expense" as TxType });

  const load = useCallback(async () => {
    try {
      const [tx, bd, goal] = await Promise.all([
        authorizedRequest<Transaction[]>("/transactions"),
        authorizedRequest<Budget[]>("/budgets"),
        authorizedRequest<SavingsGoal | null>("/savings-goal"),
      ]);
      setTransactions(tx);
      setBudgets(bd);
      setSavingsGoal(goal);
    } catch {
      Alert.alert("Couldn’t load data", "Check your connection and try again.");
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => { load(); }, [load]);
  const current = useMemo(() => transactions.filter((t) => t.date.startsWith(month)), [transactions, month]);
  const spent = current.filter((t) => t.type === "expense").reduce((s, t) => s + t.amount, 0);
  const income = current.filter((t) => t.type === "income").reduce((s, t) => s + t.amount, 0);
  const savings = current.filter((t) => t.type === "savings").reduce((s, t) => s + t.amount, 0);
  const totalSavings = useMemo(() => transactions.filter((t) => t.type === "savings").reduce((s, t) => s + t.amount, 0), [transactions]);
  const balance = transactions.reduce((s, t) => s + (t.type === "income" ? t.amount : t.type === "expense" ? -t.amount : 0), 0);
  const byCategory = TRANSFERRED_CATEGORIES.map((category) => ({ category, amount: current.filter((t) => t.type === "expense" && t.category === category).reduce((s, t) => s + t.amount, 0) })).filter((x) => x.amount > 0).sort((a, b) => b.amount - a.amount);
  const max = byCategory[0]?.amount || 1;
  const budgetMap = useMemo(() => Object.fromEntries(budgets.map((b) => [b.category, b.monthly_limit])) as Record<string, number>, [budgets]);
  const overBudget = useMemo(() => byCategory.filter((x) => budgetMap[x.category] && x.amount > budgetMap[x.category]), [byCategory, budgetMap]);
  const isCurrentMonth = month === nowMonth();
  const openAdd = () => { setEditing(null); setForm({ amount: "", category: TRANSFERRED_CATEGORIES[0], note: "", type: "expense" }); setEditorOpen(true); };
  const openEdit = (t: Transaction) => { setEditing(t); setForm({ amount: String(t.amount), category: t.category, note: t.note || "", type: t.type }); setActionsFor(null); setEditorOpen(true); };
  const closeEditor = () => { setEditorOpen(false); setEditing(null); };
  const chooseType = (type: TxType) => {
    const list = categoriesFor(type);
    setForm((f) => ({ ...f, type, category: list.includes(f.category) ? f.category : list[0] }));
  };
  const submitTransaction = async () => {
    const amount = Number(form.amount);
    if (!amount || amount <= 0) return Alert.alert("Add an amount", "Enter a value greater than zero.");
    const payload = { ...form, amount, date: editing?.date || new Date().toISOString().slice(0, 10), note: form.note.trim() };
    try {
      if (editing) {
        const updated = await authorizedRequest<Transaction>(`/transactions/${editing.id}`, { method: "PUT", body: JSON.stringify(payload) });
        setTransactions((x) => x.map((t) => (t.id === editing.id ? updated : t)));
      } else {
        const created = await authorizedRequest<Transaction>("/transactions", { method: "POST", body: JSON.stringify(payload) });
        setTransactions((x) => [created, ...x]);
      }
      closeEditor();
    } catch { Alert.alert("Couldn’t save", "Please try again."); }
  };
  const deleteTransaction = async (t: Transaction) => {
    try {
      await authorizedRequest(`/transactions/${t.id}`, { method: "DELETE" });
      setTransactions((x) => x.filter((r) => r.id !== t.id));
      setActionsFor(null);
      setConfirmDelete(null);
    } catch { Alert.alert("Couldn’t delete", "Please try again."); }
  };
  const askDelete = (t: Transaction) => {
    setActionsFor(null);
    setConfirmDelete(t);
  };
  const saveBudget = async (category: string, limit: number) => {
    try {
      const saved = await authorizedRequest<Budget>("/budgets", { method: "PUT", body: JSON.stringify({ category, monthly_limit: limit }) });
      setBudgets((prev) => [...prev.filter((b) => b.category !== category), saved]);
      setBudgetSheet(null);
    } catch { Alert.alert("Couldn’t save budget", "Please try again."); }
  };
  const removeBudget = async (category: string) => {
    try {
      await authorizedRequest(`/budgets/${encodeURIComponent(category)}`, { method: "DELETE" });
      setBudgets((prev) => prev.filter((b) => b.category !== category));
      setBudgetSheet(null);
    } catch { Alert.alert("Couldn’t remove", "Please try again."); }
  };
  const saveGoal = async (target: number) => {
    try {
      const saved = await authorizedRequest<SavingsGoal>("/savings-goal", { method: "PUT", body: JSON.stringify({ target }) });
      setSavingsGoal(saved);
      setGoalSheetOpen(false);
    } catch { Alert.alert("Couldn’t save goal", "Please try again."); }
  };
  const removeGoal = async () => {
    try {
      await authorizedRequest("/savings-goal", { method: "DELETE" });
      setSavingsGoal(null);
      setGoalSheetOpen(false);
    } catch { Alert.alert("Couldn’t remove goal", "Please try again."); }
  };

  return <SafeAreaView style={styles.safe}><ScrollView contentContainerStyle={styles.content} showsVerticalScrollIndicator={false}>
    <View style={styles.top}><View><Text style={styles.eyebrow}>PERSONAL FINANCE</Text><Text style={styles.title}>Hi {user.username}</Text><Text style={styles.sectionSub}>{user.email}</Text></View><Pressable testID="open-settings" onPress={() => setSettingsOpen(true)} style={styles.avatar}><Text style={styles.avatarText}>{user.username.slice(0, 2).toUpperCase()}</Text></Pressable></View>
    <View style={styles.hero}><View style={styles.heroTop}><Text style={styles.heroLabel}>TOTAL BALANCE</Text><Feather name="more-horizontal" size={20} color="#B5C8BE" /></View><Text testID="total-balance" style={[styles.balance, balance < 0 && styles.balanceNeg]}>{balance < 0 ? "-" : ""}{money(balance)}</Text><View style={styles.delta}><Feather name="trending-up" size={13} color="#D7E8DE" /><Text style={styles.deltaText}>On track this month</Text></View><View style={styles.heroBottom}><Text style={styles.heroSmall}>Updated just now</Text><Text style={styles.heroSmall}>{transactions.length} transactions</Text></View></View>
    {overBudget.length > 0 && <View testID="budget-alert-banner" style={styles.alertBanner}><Feather name="alert-triangle" size={16} color={COLORS.red} /><Text style={styles.alertText}>Over budget on {overBudget.map((x) => x.category).join(", ")}</Text></View>}
    {balance < 0 && <View testID="low-balance-alert" style={styles.lowBalanceCard}><View style={styles.lowBalanceIcon}><Feather name="trending-down" size={18} color={COLORS.red} /></View><View style={{ flex: 1 }}><Text style={styles.lowBalanceTitle}>Balance is in the red</Text><Text style={styles.lowBalanceSub}>You’ve transferred {money(balance)} more than you’ve received. Ease up or add income to get back on track.</Text></View></View>}
    <View style={styles.tabs}>{["Overview", "Analytics", "Categories"].map((x) => <Pressable testID={`tab-${x.toLowerCase()}`} key={x} onPress={() => setTab(x)} style={[styles.tab, tab === x && styles.tabActive]}><Text style={[styles.tabText, tab === x && styles.tabTextActive]}>{x}</Text></Pressable>)}</View>
    {loading ? <ActivityIndicator color={COLORS.green} style={styles.loader} /> : tab === "Categories" ? <CategoriesView data={byCategory} max={max} budgetMap={budgetMap} onEditBudget={setBudgetSheet} /> : tab === "Analytics" ? <Analytics spent={spent} income={income} data={byCategory} max={max} /> : <>
      <View style={styles.monthPicker}>
        <Pressable testID="prev-month" onPress={() => setMonth((m) => shiftMonth(m, -1))} style={styles.monthNav}><Feather name="chevron-left" size={18} color={COLORS.ink} /></Pressable>
        <Text testID="month-label" style={styles.monthText}>{monthLabel(month)}</Text>
        <Pressable testID="next-month" disabled={isCurrentMonth} onPress={() => setMonth((m) => shiftMonth(m, 1))} style={[styles.monthNav, isCurrentMonth && { opacity: 0.3 }]}><Feather name="chevron-right" size={18} color={COLORS.ink} /></Pressable>
      </View>
      <View style={styles.sectionHeader}><View><Text style={styles.sectionTitle}>Monthly summary</Text><Text style={styles.sectionSub}>{isCurrentMonth ? "Live overview" : "Past month view"}</Text></View><Pressable testID="add-transaction-small" onPress={openAdd} style={styles.addSmall}><Feather name="plus" size={18} color="#FFF" /></Pressable></View>
      <View style={styles.summaryGrid}><Metric label="Transferred" value={spent} tone={COLORS.red} icon="arrow-up-right" /><Metric label="Received" value={income} tone={COLORS.green} icon="arrow-down-left" /><Metric label="Savings" value={savings} tone={COLORS.gold} icon="pie-chart" /></View>
      <SavingsGoalCard goal={savingsGoal} saved={totalSavings} onEdit={() => setGoalSheetOpen(true)} />
      <View style={styles.card}><Text style={styles.cardTitle}>Spending by category</Text>{byCategory.length === 0 ? <Empty onAdd={openAdd} /> : byCategory.slice(0, 5).map((x) => <Bar key={x.category} category={x.category} amount={x.amount} max={max} limit={budgetMap[x.category]} />)}</View>
      <View style={styles.sectionHeader}><View><Text style={styles.sectionTitle}>Recent activity</Text><Text style={styles.sectionSub}>Long-press to edit or delete</Text></View><Text style={styles.seeAll}>See all</Text></View>
      <View style={styles.card}>{current.slice(0, 5).map((t) => <TransactionRow key={t.id} t={t} onLongPress={() => setActionsFor(t)} />)}{current.length === 0 && <Text style={styles.emptyText}>No transactions recorded for {monthLabel(month)}.</Text>}</View>
    </>}
  </ScrollView><View style={styles.bottom}><Nav icon="grid" label="Overview" active={tab === "Overview"} onPress={() => setTab("Overview")} /><Nav icon="bar-chart-2" label="Analytics" active={tab === "Analytics"} onPress={() => setTab("Analytics")} /><Pressable testID="add-transaction-fab" style={styles.fab} onPress={openAdd}><Feather name="plus" size={24} color="#FFF" /></Pressable><Nav icon="layers" label="Categories" active={tab === "Categories"} onPress={() => setTab("Categories")} /><Nav icon="settings" label="Settings" active={false} onPress={() => setSettingsOpen(true)} /></View>
    <Modal visible={editorOpen} transparent animationType="slide" onRequestClose={closeEditor}><KeyboardAvoidingView behavior={Platform.OS === "ios" ? "padding" : "height"} style={styles.modalShade}><View style={[styles.modal, { maxHeight: "92%" }]}><ScrollView keyboardShouldPersistTaps="handled" showsVerticalScrollIndicator={false} contentContainerStyle={{ gap: 12, paddingBottom: 8 }}><View style={styles.modalHead}><Text style={styles.modalTitle}>{editing ? "Edit transaction" : "Add transaction"}</Text><Pressable testID="close-add-transaction" onPress={closeEditor}><Feather name="x" size={22} color={COLORS.muted} /></Pressable></View><View style={styles.typeRow}><Pressable testID="type-expense" onPress={() => chooseType("expense")} style={[styles.type, form.type === "expense" && styles.typeExpense]}><Text style={[styles.typeText, form.type === "expense" && { color: COLORS.red }]} numberOfLines={1}>Transferred</Text></Pressable><Pressable testID="type-income" onPress={() => chooseType("income")} style={[styles.type, form.type === "income" && styles.typeIncome]}><Text style={[styles.typeText, form.type === "income" && { color: COLORS.green }]} numberOfLines={1}>Received</Text></Pressable><Pressable testID="type-savings" onPress={() => chooseType("savings")} style={[styles.type, form.type === "savings" && styles.typeSavings]}><Text style={[styles.typeText, form.type === "savings" && { color: COLORS.gold }]} numberOfLines={1}>Savings</Text></Pressable></View><Text style={styles.inputLabel}>AMOUNT</Text><TextInput testID="transaction-amount" value={form.amount} onChangeText={(amount) => setForm({ ...form, amount })} keyboardType="decimal-pad" placeholder="₹ 0" placeholderTextColor="#A9AAA5" style={styles.input} /><Text style={styles.inputLabel}>CATEGORY</Text><ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.chips}>{categoriesFor(form.type).map((c) => <Pressable testID={`category-${c.toLowerCase().replace(/\s+/g, "-")}`} key={c} onPress={() => setForm({ ...form, category: c })} style={[styles.chip, form.category === c && styles.chipActive]}><Text style={[styles.chipText, form.category === c && styles.chipTextActive]}>{c}</Text></Pressable>)}</ScrollView><Text style={styles.inputLabel}>NOTE</Text><TextInput value={form.note} onChangeText={(note) => setForm({ ...form, note })} placeholder="Optional note" placeholderTextColor="#A9AAA5" style={styles.input} /><Pressable testID="save-transaction" onPress={submitTransaction} style={styles.save}><Text style={styles.saveText}>{editing ? "Save changes" : "Save transaction"}</Text></Pressable></ScrollView></View></KeyboardAvoidingView></Modal>
    <TransactionActionsSheet t={actionsFor} onClose={() => setActionsFor(null)} onEdit={openEdit} onDelete={askDelete} />
    <ConfirmDeleteSheet t={confirmDelete} onCancel={() => setConfirmDelete(null)} onConfirm={deleteTransaction} />
    <BudgetSheet category={budgetSheet} currentLimit={budgetSheet ? budgetMap[budgetSheet] : undefined} onClose={() => setBudgetSheet(null)} onSave={saveBudget} onRemove={removeBudget} />
    <SavingsGoalSheet visible={goalSheetOpen} currentTarget={savingsGoal?.target} saved={totalSavings} onClose={() => setGoalSheetOpen(false)} onSave={saveGoal} onRemove={removeGoal} />
    <SettingsSheet visible={settingsOpen} month={month} monthTransactions={current} onClose={() => setSettingsOpen(false)} onChangePassword={() => { setSettingsOpen(false); setChangePwOpen(true); }} onSignedOut={() => { setSettingsOpen(false); signOut().then(onSignedOut); }} />
    <ChangePasswordSheet visible={changePwOpen} onClose={() => setChangePwOpen(false)} />
  </SafeAreaView>;
}

function SettingsSheet({ visible, month, monthTransactions, onClose, onChangePassword, onSignedOut }: { visible: boolean; month: string; monthTransactions: Transaction[]; onClose: () => void; onChangePassword: () => void; onSignedOut: () => void }) {
  const [busy, setBusy] = useState(false);
  const shareCsv = async () => {
    if (busy) return;
    setBusy(true);
    try {
      const token = await storage.secureGet("spendpulse-auth-token", null);
      const res = await fetch(`${process.env.EXPO_PUBLIC_BACKEND_URL}/api/transactions/export?month=${month}`, { headers: { Authorization: `Bearer ${token}` } });
      if (!res.ok) throw new Error("Export failed");
      const csv = await res.text();
      await Share.share({ title: `SpendPulse ${monthLabel(month)}.csv`, message: csv });
    } catch { Alert.alert("Couldn’t export", "Please try again."); }
    finally { setBusy(false); }
  };
  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <Pressable style={styles.modalShade} onPress={onClose}>
        <Pressable style={styles.modal} onPress={(e) => e.stopPropagation()}>
          <View style={styles.modalHead}>
            <Text style={styles.modalTitle}>Settings</Text>
            <Pressable testID="close-settings" onPress={onClose}><Feather name="x" size={22} color={COLORS.muted} /></Pressable>
          </View>
          <Text style={styles.emptyText}>{monthTransactions.length} transactions recorded in {monthLabel(month)}.</Text>
          <Pressable testID="export-csv" onPress={shareCsv} disabled={busy || monthTransactions.length === 0} style={[styles.actionBtn, (busy || monthTransactions.length === 0) && { opacity: 0.55 }]}>
            <Feather name="download" size={18} color={COLORS.ink} />
            <Text style={styles.actionText}>{busy ? "Preparing…" : `Export ${monthLabel(month)} as CSV`}</Text>
          </Pressable>
          <Pressable testID="change-password" onPress={onChangePassword} style={styles.actionBtn}>
            <Feather name="lock" size={18} color={COLORS.ink} />
            <Text style={styles.actionText}>Change password</Text>
          </Pressable>
          <Pressable testID="settings-logout" onPress={onSignedOut} style={[styles.actionBtn, styles.actionBtnDanger]}>
            <Feather name="log-out" size={18} color={COLORS.red} />
            <Text style={[styles.actionText, { color: COLORS.red }]}>Log out</Text>
          </Pressable>
        </Pressable>
      </Pressable>
    </Modal>
  );
}

function ChangePasswordSheet({ visible, onClose }: { visible: boolean; onClose: () => void }) {
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [ok, setOk] = useState(false);
  useEffect(() => { if (!visible) { setCurrent(""); setNext(""); setError(""); setOk(false); } }, [visible]);
  const submit = async () => {
    if (!current || next.length < 8) { setError("Enter your current password and a new one (8+ characters)."); return; }
    setBusy(true); setError("");
    try {
      await authorizedRequest("/auth/change-password", { method: "POST", body: JSON.stringify({ current_password: current, new_password: next }) });
      setOk(true);
      setTimeout(onClose, 900);
    } catch (e) { setError(e instanceof Error ? e.message : "Please try again."); }
    finally { setBusy(false); }
  };
  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <KeyboardAvoidingView behavior={Platform.OS === "ios" ? "padding" : "height"} style={styles.modalShade}>
        <View style={styles.modal}>
          <View style={styles.modalHead}>
            <Text style={styles.modalTitle}>Change password</Text>
            <Pressable testID="close-change-password" onPress={onClose}><Feather name="x" size={22} color={COLORS.muted} /></Pressable>
          </View>
          <Text style={styles.inputLabel}>CURRENT PASSWORD</Text>
          <TextInput testID="current-password" value={current} onChangeText={setCurrent} secureTextEntry placeholder="Your current password" placeholderTextColor="#A9AAA5" style={styles.input} />
          <Text style={styles.inputLabel}>NEW PASSWORD</Text>
          <TextInput testID="new-password" value={next} onChangeText={setNext} secureTextEntry placeholder="At least 8 characters" placeholderTextColor="#A9AAA5" style={styles.input} />
          {error ? <Text style={authStyles.authError}>{error}</Text> : null}
          {ok ? <Text style={authStyles.authInfo}>Password updated.</Text> : null}
          <Pressable testID="submit-change-password" onPress={submit} disabled={busy || ok} style={[styles.save, (busy || ok) && authStyles.disabled]}>
            {busy ? <ActivityIndicator color="#FFF" /> : <Text style={styles.saveText}>Update password</Text>}
          </Pressable>
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}

function TransactionActionsSheet({ t, onClose, onEdit, onDelete }: { t: Transaction | null; onClose: () => void; onEdit: (t: Transaction) => void; onDelete: (t: Transaction) => void }) {
  return (
    <Modal visible={!!t} transparent animationType="slide" onRequestClose={onClose}>
      <Pressable style={styles.modalShade} onPress={onClose}>
        <Pressable style={styles.modal} onPress={(e) => e.stopPropagation()}>
          <View style={styles.modalHead}>
            <Text style={styles.modalTitle}>{t?.category}</Text>
            <Pressable testID="close-actions" onPress={onClose}><Feather name="x" size={22} color={COLORS.muted} /></Pressable>
          </View>
          <Text style={styles.emptyText}>{t?.type === "income" ? "Received" : t?.type === "savings" ? "Saved" : "Transferred"} · {t ? money(t.amount) : ""} · {t?.date}</Text>
          {t?.note ? <Text style={styles.emptyText}>Note: {t.note}</Text> : null}
          <Pressable testID="edit-transaction" onPress={() => t && onEdit(t)} style={styles.actionBtn}>
            <Feather name="edit-2" size={18} color={COLORS.ink} />
            <Text style={styles.actionText}>Edit transaction</Text>
          </Pressable>
          <Pressable testID="delete-transaction" onPress={() => t && onDelete(t)} style={[styles.actionBtn, styles.actionBtnDanger]}>
            <Feather name="trash-2" size={18} color={COLORS.red} />
            <Text style={[styles.actionText, { color: COLORS.red }]}>Delete transaction</Text>
          </Pressable>
        </Pressable>
      </Pressable>
    </Modal>
  );
}

function ConfirmDeleteSheet({ t, onCancel, onConfirm }: { t: Transaction | null; onCancel: () => void; onConfirm: (t: Transaction) => void }) {
  return (
    <Modal visible={!!t} transparent animationType="fade" onRequestClose={onCancel}>
      <Pressable style={styles.modalShade} onPress={onCancel}>
        <Pressable style={styles.modal} onPress={(e) => e.stopPropagation()}>
          <View style={styles.modalHead}>
            <Text style={styles.modalTitle}>Delete transaction?</Text>
            <Pressable testID="close-confirm-delete" onPress={onCancel}><Feather name="x" size={22} color={COLORS.muted} /></Pressable>
          </View>
          <Text style={styles.emptyText}>{t ? `${t.category} · ${money(t.amount)} · ${t.date}` : ""}</Text>
          <Text style={styles.emptyText}>This can’t be undone.</Text>
          <Pressable testID="confirm-delete" onPress={() => t && onConfirm(t)} style={[styles.save, { backgroundColor: COLORS.red }]}>
            <Text style={styles.saveText}>Delete transaction</Text>
          </Pressable>
          <Pressable testID="cancel-delete" onPress={onCancel} style={styles.remove}><Text style={authStyles.linkText}>Cancel</Text></Pressable>
        </Pressable>
      </Pressable>
    </Modal>
  );
}

function BudgetSheet({ category, currentLimit, onClose, onSave, onRemove }: { category: string | null; currentLimit?: number; onClose: () => void; onSave: (c: string, l: number) => void; onRemove: (c: string) => void }) {
  const [value, setValue] = useState("");
  useEffect(() => { setValue(currentLimit ? String(currentLimit) : ""); }, [currentLimit, category]);
  const submit = () => {
    if (!category) return;
    const n = Number(value);
    if (!n || n <= 0) return Alert.alert("Enter a limit", "Set a monthly limit greater than zero.");
    onSave(category, n);
  };
  return (
    <Modal visible={!!category} transparent animationType="slide" onRequestClose={onClose}>
      <KeyboardAvoidingView behavior={Platform.OS === "ios" ? "padding" : "height"} style={styles.modalShade}>
        <View style={styles.modal}>
          <View style={styles.modalHead}>
            <Text style={styles.modalTitle}>Budget · {category}</Text>
            <Pressable testID="close-budget-sheet" onPress={onClose}><Feather name="x" size={22} color={COLORS.muted} /></Pressable>
          </View>
          <Text style={styles.emptyText}>Set a monthly limit for {category}. We’ll alert you when spending is close.</Text>
          <Text style={styles.inputLabel}>MONTHLY LIMIT</Text>
          <TextInput testID="budget-amount" value={value} onChangeText={setValue} keyboardType="decimal-pad" placeholder="₹ 0" placeholderTextColor="#A9AAA5" style={styles.input} />
          <Pressable testID="save-budget" onPress={submit} style={styles.save}><Text style={styles.saveText}>Save budget</Text></Pressable>
          {currentLimit ? <Pressable testID="remove-budget" onPress={() => category && onRemove(category)} style={styles.remove}><Text style={styles.removeText}>Remove budget</Text></Pressable> : null}
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}

function AuthScreen({ onAuthenticated }: { onAuthenticated: (user: User) => void }) {
  const [mode, setMode] = useState<"login" | "signup">("login");
  const [username, setUsername] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [forgotOpen, setForgotOpen] = useState(false);
  const [resetOpen, setResetOpen] = useState(false);
  const submit = async () => {
    const trimmedUsername = username.trim().toLowerCase();
    if (!trimmedUsername || trimmedUsername.length < 3 || !/^[a-z0-9_.]+$/.test(trimmedUsername)) { setError("Username must be 3+ characters — letters, numbers, dot or underscore."); return; }
    if (password.length < 8) { setError("Password must be at least 8 characters."); return; }
    if (mode === "signup" && !email.trim()) { setError("Enter an email so you can reset your password later."); return; }
    setBusy(true); setError("");
    try { const user = mode === "login" ? await signIn(trimmedUsername, password) : await signUp(trimmedUsername, email.trim().toLowerCase(), password); onAuthenticated(user); }
    catch (e) { setError(e instanceof Error ? e.message : "Authentication failed"); }
    finally { setBusy(false); }
  };
  return <SafeAreaView style={styles.safe}>
    <KeyboardAvoidingView behavior={Platform.OS === "ios" ? "padding" : "height"} style={authStyles.authScreen}>
      <ScrollView keyboardShouldPersistTaps="handled" showsVerticalScrollIndicator={false} contentContainerStyle={authStyles.authContent}>
        <View style={authStyles.authBrand}><View style={authStyles.authMark}><Feather name="activity" size={22} color="#FFF" /></View><Text style={authStyles.authBrandText}>SpendPulse</Text></View>
        <View>
          <Text style={authStyles.authEyebrow}>{mode === "login" ? "WELCOME BACK" : "START FRESH"}</Text>
          <Text style={authStyles.authTitle}>{mode === "login" ? "Your money, in focus." : "Build a clearer money habit."}</Text>
          <Text style={authStyles.authSub}>A calm, private view of your spending and monthly progress.</Text>
        </View>
        <View style={authStyles.authForm}>
          <Text style={styles.inputLabel}>USERNAME</Text>
          <TextInput testID="auth-username" value={username} onChangeText={setUsername} autoCapitalize="none" autoCorrect={false} placeholder="e.g. SABA" placeholderTextColor="#A9AAA5" style={styles.input} />
          {mode === "signup" && <>
            <Text style={styles.inputLabel}>EMAIL (for password reset)</Text>
            <TextInput testID="auth-email" value={email} onChangeText={setEmail} autoCapitalize="none" autoCorrect={false} keyboardType="email-address" placeholder="you@example.com" placeholderTextColor="#A9AAA5" style={styles.input} />
          </>}
          <Text style={styles.inputLabel}>PASSWORD</Text>
          <TextInput testID="auth-password" value={password} onChangeText={setPassword} secureTextEntry placeholder="At least 8 characters" placeholderTextColor="#A9AAA5" style={styles.input} />
          {error ? <Text style={authStyles.authError}>{error}</Text> : null}
          <Pressable testID="auth-submit" onPress={submit} disabled={busy} style={[styles.save, busy && authStyles.disabled]}>
            {busy ? <ActivityIndicator color="#FFF" /> : <Text style={styles.saveText}>{mode === "login" ? "Log in" : "Create account"}</Text>}
          </Pressable>
          {mode === "login" && (
            <Pressable testID="auth-forgot" onPress={() => setForgotOpen(true)} style={authStyles.linkRow}>
              <Text style={authStyles.linkText}>Forgot password?</Text>
            </Pressable>
          )}
        </View>
        <Pressable testID="auth-toggle" onPress={() => { setMode(mode === "login" ? "signup" : "login"); setError(""); }}>
          <Text style={authStyles.authToggle}>{mode === "login" ? "New to SpendPulse? Create an account" : "Already have an account? Log in"}</Text>
        </Pressable>
      </ScrollView>
    </KeyboardAvoidingView>
    <ForgotPasswordSheet visible={forgotOpen} onClose={() => setForgotOpen(false)} onSent={() => { setForgotOpen(false); setResetOpen(true); }} />
    <ResetPasswordSheet visible={resetOpen} onClose={() => setResetOpen(false)} onDone={onAuthenticated} />
  </SafeAreaView>;
}

function ForgotPasswordSheet({ visible, onClose, onSent }: { visible: boolean; onClose: () => void; onSent: () => void }) {
  const [email, setEmail] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const submit = async () => {
    if (!email.trim()) { setMessage("Enter your account email."); return; }
    setBusy(true); setMessage("");
    try {
      const res = await forgotPassword(email.trim().toLowerCase());
      setMessage(res.message);
      setTimeout(onSent, 600);
    } catch (e) {
      setMessage(e instanceof Error ? e.message : "Please try again.");
    } finally { setBusy(false); }
  };
  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <KeyboardAvoidingView behavior={Platform.OS === "ios" ? "padding" : "height"} style={styles.modalShade}>
        <View style={styles.modal}>
          <View style={styles.modalHead}>
            <Text style={styles.modalTitle}>Reset password</Text>
            <Pressable testID="close-forgot" onPress={onClose}><Feather name="x" size={22} color={COLORS.muted} /></Pressable>
          </View>
          <Text style={styles.emptyText}>Enter the email you used at signup. We’ll send a reset code that works for 30 minutes.</Text>
          <Text style={authStyles.authInfo}>If you don’t see it, check your spam or promotions folder.</Text>
          <Text style={styles.inputLabel}>EMAIL</Text>
          <TextInput testID="forgot-email" value={email} onChangeText={setEmail} autoCapitalize="none" autoCorrect={false} keyboardType="email-address" placeholder="you@example.com" placeholderTextColor="#A9AAA5" style={styles.input} />
          {message ? <Text style={authStyles.authInfo}>{message}</Text> : null}
          <Pressable testID="forgot-submit" onPress={submit} disabled={busy} style={[styles.save, busy && authStyles.disabled]}>
            {busy ? <ActivityIndicator color="#FFF" /> : <Text style={styles.saveText}>Send reset code</Text>}
          </Pressable>
          <Pressable testID="have-code" onPress={onSent} style={styles.remove}><Text style={authStyles.linkText}>I already have a code</Text></Pressable>
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}

function ResetPasswordSheet({ visible, onClose, onDone }: { visible: boolean; onClose: () => void; onDone: (u: User) => void }) {
  const [code, setCode] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const submit = async () => {
    if (!code.trim() || password.length < 8) { setError("Enter your code and a new password (8+ chars)."); return; }
    setBusy(true); setError("");
    try {
      const user = await resetPassword(code.trim(), password);
      onDone(user);
    } catch (e) { setError(e instanceof Error ? e.message : "Please try again."); }
    finally { setBusy(false); }
  };
  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <KeyboardAvoidingView behavior={Platform.OS === "ios" ? "padding" : "height"} style={styles.modalShade}>
        <View style={styles.modal}>
          <View style={styles.modalHead}>
            <Text style={styles.modalTitle}>Enter reset code</Text>
            <Pressable testID="close-reset" onPress={onClose}><Feather name="x" size={22} color={COLORS.muted} /></Pressable>
          </View>
          <Text style={styles.emptyText}>Paste the code from the email and pick a new password. Codes expire in 30 minutes.</Text>
          <Text style={styles.inputLabel}>RESET CODE</Text>
          <TextInput testID="reset-code" value={code} onChangeText={setCode} autoCapitalize="none" autoCorrect={false} placeholder="Paste code from email" placeholderTextColor="#A9AAA5" style={styles.input} />
          <Text style={styles.inputLabel}>NEW PASSWORD</Text>
          <TextInput testID="reset-password" value={password} onChangeText={setPassword} secureTextEntry placeholder="At least 8 characters" placeholderTextColor="#A9AAA5" style={styles.input} />
          {error ? <Text style={authStyles.authError}>{error}</Text> : null}
          <Pressable testID="reset-submit" onPress={submit} disabled={busy} style={[styles.save, busy && authStyles.disabled]}>
            {busy ? <ActivityIndicator color="#FFF" /> : <Text style={styles.saveText}>Update password</Text>}
          </Pressable>
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}

function ProgressRing({ pct, size = 96, stroke = 10, color = COLORS.gold }: { pct: number; size?: number; stroke?: number; color?: string }) {
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  const clamped = Math.max(0, Math.min(100, pct));
  const offset = c - (clamped / 100) * c;
  return (
    <View style={{ width: size, height: size, alignItems: "center", justifyContent: "center" }}>
      <Svg width={size} height={size}>
        <Circle cx={size / 2} cy={size / 2} r={r} stroke={COLORS.pale} strokeWidth={stroke} fill="none" />
        <Circle cx={size / 2} cy={size / 2} r={r} stroke={color} strokeWidth={stroke} fill="none" strokeLinecap="round" strokeDasharray={c} strokeDashoffset={offset} transform={`rotate(-90 ${size / 2} ${size / 2})`} />
      </Svg>
      <View style={styles.ringCenter}><Text testID="savings-goal-percent" style={styles.ringPct}>{Math.round(clamped)}%</Text></View>
    </View>
  );
}

function SavingsGoalCard({ goal, saved, onEdit }: { goal: SavingsGoal | null; saved: number; onEdit: () => void }) {
  if (!goal) {
    return (
      <Pressable testID="set-savings-goal" onPress={onEdit} style={styles.goalEmptyCard}>
        <View style={styles.goalEmptyIcon}><Feather name="target" size={20} color={COLORS.gold} /></View>
        <View style={{ flex: 1 }}>
          <Text style={styles.cardTitleTight}>Set a savings goal</Text>
          <Text style={styles.goalEmptySub}>Pick a target and watch your set-aside money fill the ring.</Text>
        </View>
        <Feather name="plus-circle" size={20} color={COLORS.gold} />
      </Pressable>
    );
  }
  const pct = goal.target > 0 ? (saved / goal.target) * 100 : 0;
  const reached = saved >= goal.target;
  const remaining = Math.max(0, goal.target - saved);
  return (
    <View testID="savings-goal-card" style={styles.goalCard}>
      <ProgressRing pct={pct} color={reached ? COLORS.green : COLORS.gold} />
      <View style={styles.goalInfo}>
        <View style={styles.goalHeadRow}>
          <Text style={styles.cardTitleTight}>Savings goal</Text>
          <Pressable testID="edit-savings-goal" onPress={onEdit} hitSlop={10}><Feather name="edit-2" size={16} color={COLORS.muted} /></Pressable>
        </View>
        <Text style={styles.goalSaved}>{money(saved)} <Text style={styles.goalTarget}>/ {money(goal.target)}</Text></Text>
        <Text style={styles.goalRemaining}>{reached ? "🎉 Goal reached — nice work!" : `${money(remaining)} to go`}</Text>
      </View>
    </View>
  );
}

function SavingsGoalSheet({ visible, currentTarget, saved, onClose, onSave, onRemove }: { visible: boolean; currentTarget?: number; saved: number; onClose: () => void; onSave: (t: number) => void; onRemove: () => void }) {
  const [value, setValue] = useState("");
  useEffect(() => { if (visible) setValue(currentTarget ? String(currentTarget) : ""); }, [currentTarget, visible]);
  const submit = () => {
    const n = Number(value);
    if (!n || n <= 0) return Alert.alert("Enter a target", "Set a savings target greater than zero.");
    onSave(n);
  };
  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <KeyboardAvoidingView behavior={Platform.OS === "ios" ? "padding" : "height"} style={styles.modalShade}>
        <View style={styles.modal}>
          <View style={styles.modalHead}>
            <Text style={styles.modalTitle}>Savings goal</Text>
            <Pressable testID="close-savings-goal" onPress={onClose}><Feather name="x" size={22} color={COLORS.muted} /></Pressable>
          </View>
          <Text style={styles.emptyText}>You’ve set aside {money(saved)} so far. Set a target to track your progress.</Text>
          <Text style={styles.inputLabel}>TARGET AMOUNT</Text>
          <TextInput testID="savings-goal-amount" value={value} onChangeText={setValue} keyboardType="decimal-pad" placeholder="₹ 0" placeholderTextColor="#A9AAA5" style={styles.input} />
          <Pressable testID="save-savings-goal" onPress={submit} style={styles.save}><Text style={styles.saveText}>Save goal</Text></Pressable>
          {currentTarget ? <Pressable testID="remove-savings-goal" onPress={onRemove} style={styles.remove}><Text style={styles.removeText}>Remove goal</Text></Pressable> : null}
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}

function Metric({ label, value, tone, icon }: { label: string; value: number; tone: string; icon: keyof typeof Feather.glyphMap }) { return <View style={styles.metric}><View style={[styles.metricIcon, { backgroundColor: `${tone}18` }]}><Feather name={icon} size={16} color={tone} /></View><Text style={styles.metricLabel}>{label}</Text><Text style={styles.metricValue}>{money(value)}</Text></View>; }

function Bar({ category, amount, max, limit }: { category: string; amount: number; max: number; limit?: number }) {
  const hasBudget = typeof limit === "number" && limit > 0;
  const pct = hasBudget ? Math.min(100, (amount / limit) * 100) : Math.max(8, (amount / max) * 100);
  const over = hasBudget && amount > limit;
  const near = hasBudget && !over && amount / limit >= 0.8;
  const fillColor = over ? COLORS.red : near ? COLORS.gold : COLORS.green;
  return (
    <View style={styles.barWrap}>
      <View style={styles.barLine}>
        <Text style={styles.barLabel}>{category}</Text>
        <Text style={styles.barAmount}>{money(amount)}{hasBudget ? ` / ${money(limit)}` : ""}</Text>
      </View>
      <View style={styles.track}><View style={[styles.fill, { width: `${pct}%`, backgroundColor: fillColor }]} /></View>
      {over ? <Text style={styles.overText}>Over budget by {money(amount - limit)}</Text> : null}
    </View>
  );
}

function CategoriesView({ data, max, budgetMap, onEditBudget }: { data: { category: string; amount: number }[]; max: number; budgetMap: Record<string, number>; onEditBudget: (c: string) => void }) {
  return (
    <View style={styles.card}>
      <View style={styles.rowBetween}>
        <Text style={styles.cardTitle}>Category performance</Text>
        <Text style={styles.sectionSub}>Tap to set budget</Text>
      </View>
      {TRANSFERRED_CATEGORIES.map((c) => {
        const amount = data.find((x) => x.category === c)?.amount || 0;
        const limit = budgetMap[c];
        return (
          <Pressable key={c} testID={`budget-row-${c.toLowerCase()}`} onPress={() => onEditBudget(c)} style={styles.budgetRow}>
            <View style={{ flex: 1 }}>
              <Bar category={c} amount={amount} max={max} limit={limit} />
            </View>
            <Feather name={limit ? "edit-2" : "plus-circle"} size={16} color={COLORS.muted} style={{ marginLeft: 10, marginTop: 6 }} />
          </Pressable>
        );
      })}
    </View>
  );
}

function Analytics({ spent, income, data, max }: { spent: number; income: number; data: { category: string; amount: number }[]; max: number }) { return <><View style={styles.card}><Text style={styles.cardTitle}>Cash flow this month</Text><View style={styles.flow}><View style={[styles.flowBar, { height: Math.max(18, Math.min(130, income / Math.max(income, spent, 1) * 130)), backgroundColor: COLORS.green }]} /><View style={[styles.flowBar, { height: Math.max(18, Math.min(130, spent / Math.max(income, spent, 1) * 130)), backgroundColor: COLORS.red }]} /></View><View style={styles.flowLabels}><Text style={styles.emptyText}>Received {money(income)}</Text><Text style={styles.emptyText}>Transferred {money(spent)}</Text></View></View><View style={styles.card}><Text style={styles.cardTitle}>Top categories</Text>{data.length ? data.map((x) => <Bar key={x.category} category={x.category} amount={x.amount} max={max} />) : <Text style={styles.emptyText}>Not enough data for trends yet.</Text>}</View></>; }
function Empty({ onAdd }: { onAdd: () => void }) { return <View style={styles.empty}><Feather name="pie-chart" size={28} color={COLORS.green} /><Text style={styles.emptyTitle}>No spending recorded this month</Text><Pressable onPress={onAdd}><Text style={styles.emptyAction}>Add transaction</Text></Pressable></View>; }
function TransactionRow({ t, onLongPress }: { t: Transaction; onLongPress?: () => void }) {
  const isIncome = t.type === "income";
  const isSavings = t.type === "savings";
  const iconName = isIncome ? "arrow-down-left" : isSavings ? "pie-chart" : "shopping-bag";
  const iconColor = isIncome ? COLORS.green : isSavings ? COLORS.gold : COLORS.red;
  const amountColor = isIncome ? COLORS.green : isSavings ? COLORS.gold : COLORS.ink;
  const sign = isIncome ? "+" : isSavings ? "" : "-";
  return <Pressable testID={`transaction-row-${t.id}`} onLongPress={onLongPress} delayLongPress={350} style={styles.transaction}><View style={styles.transactionIcon}><Feather name={iconName} size={16} color={iconColor} /></View><View style={styles.transactionCopy}><Text style={styles.transactionTitle}>{t.category}</Text><Text style={styles.transactionSub}>{t.note || t.date}</Text></View><Text style={[styles.transactionAmount, { color: amountColor }]}>{sign}{money(t.amount)}</Text></Pressable>;
}
function Nav({ icon, label, active, onPress }: { icon: keyof typeof Feather.glyphMap; label: string; active: boolean; onPress: () => void }) { return <Pressable testID={`nav-${label.toLowerCase().replace(/\s+/g, "-")}`} onPress={onPress} style={styles.navItem}><Feather name={icon} size={20} color={active ? COLORS.green : COLORS.muted} /><Text style={[styles.navLabel, active && styles.navActive]}>{label}</Text></Pressable>; }

const authStyles = StyleSheet.create({ authScreen: { flex: 1 }, authContent: { padding: 24, gap: 28, flexGrow: 1, justifyContent: "space-between" }, authBrand: { flexDirection: "row", alignItems: "center", gap: 10 }, authMark: { width: 42, height: 42, borderRadius: 14, backgroundColor: COLORS.green, alignItems: "center", justifyContent: "center" }, authBrandText: { color: COLORS.ink, fontSize: 20, fontWeight: "700" }, authEyebrow: { color: COLORS.green, fontSize: 11, letterSpacing: 1.2, fontWeight: "700", marginBottom: 10 }, authTitle: { color: COLORS.ink, fontSize: 32, lineHeight: 38, fontWeight: "700", maxWidth: 320 }, authSub: { color: COLORS.muted, fontSize: 15, lineHeight: 22, marginTop: 12, maxWidth: 320 }, authForm: { gap: 10 }, authError: { color: COLORS.red, fontSize: 13, lineHeight: 18 }, authInfo: { color: COLORS.green, fontSize: 13, lineHeight: 18 }, authToggle: { color: COLORS.green, fontWeight: "700", fontSize: 13, textAlign: "center" }, disabled: { opacity: 0.65 }, linkRow: { alignItems: "center", paddingVertical: 8 }, linkText: { color: COLORS.green, fontWeight: "600", fontSize: 13 } });

const styles = StyleSheet.create({ safe: { flex: 1, backgroundColor: COLORS.bg }, content: { padding: 24, paddingBottom: 120, gap: 20 }, top: { flexDirection: "row", justifyContent: "space-between", alignItems: "center" }, eyebrow: { color: COLORS.green, fontSize: 11, letterSpacing: 1.3, fontWeight: "700", marginBottom: 6 }, title: { color: COLORS.ink, fontSize: 23, fontWeight: "700" }, avatar: { width: 44, height: 44, borderRadius: 22, backgroundColor: COLORS.pale, alignItems: "center", justifyContent: "center" }, avatarText: { color: COLORS.green, fontWeight: "700" }, hero: { backgroundColor: COLORS.green, borderRadius: 22, padding: 22, minHeight: 182, justifyContent: "space-between" }, heroTop: { flexDirection: "row", justifyContent: "space-between" }, heroLabel: { color: "#B5C8BE", fontSize: 11, letterSpacing: 1.2, fontWeight: "700" }, balance: { color: "#FFF", fontSize: 38, fontWeight: "700", letterSpacing: -1, fontVariant: ["tabular-nums"] }, balanceNeg: { color: COLORS.negBalance }, delta: { alignSelf: "flex-start", flexDirection: "row", alignItems: "center", gap: 5, backgroundColor: "#5E8272", borderRadius: 999, paddingVertical: 7, paddingHorizontal: 11 }, deltaText: { color: "#D7E8DE", fontSize: 12, fontWeight: "600" }, heroBottom: { flexDirection: "row", justifyContent: "space-between" }, heroSmall: { color: "#B5C8BE", fontSize: 12 }, alertBanner: { flexDirection: "row", alignItems: "center", gap: 8, backgroundColor: "#F8E8E8", borderRadius: 12, padding: 12, borderWidth: 1, borderColor: "#F1CFCF" }, alertText: { color: COLORS.red, fontSize: 13, fontWeight: "600", flex: 1 }, monthPicker: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", backgroundColor: COLORS.card, borderRadius: 14, borderWidth: 1, borderColor: COLORS.line, paddingHorizontal: 8, paddingVertical: 6 }, monthNav: { width: 40, height: 40, borderRadius: 12, alignItems: "center", justifyContent: "center" }, monthText: { color: COLORS.ink, fontSize: 15, fontWeight: "700" }, tabs: { flexDirection: "row", backgroundColor: COLORS.pale, borderRadius: 14, padding: 4 }, tab: { flex: 1, minHeight: 42, justifyContent: "center", alignItems: "center", borderRadius: 11 }, tabActive: { backgroundColor: COLORS.card, shadowColor: "#000", shadowOpacity: 0.06, shadowRadius: 8, elevation: 2 }, tabText: { color: COLORS.muted, fontSize: 13, fontWeight: "600" }, tabTextActive: { color: COLORS.green }, sectionHeader: { flexDirection: "row", justifyContent: "space-between", alignItems: "center" }, sectionTitle: { color: COLORS.ink, fontSize: 19, fontWeight: "700" }, sectionSub: { color: COLORS.muted, fontSize: 12, marginTop: 4 }, addSmall: { width: 38, height: 38, borderRadius: 12, backgroundColor: COLORS.green, alignItems: "center", justifyContent: "center" }, summaryGrid: { flexDirection: "row", gap: 10 }, metric: { flex: 1, backgroundColor: COLORS.card, borderRadius: 16, borderWidth: 1, borderColor: COLORS.line, padding: 13 }, metricIcon: { width: 28, height: 28, borderRadius: 9, alignItems: "center", justifyContent: "center", marginBottom: 9 }, metricLabel: { color: COLORS.muted, fontSize: 11, marginBottom: 5 }, metricValue: { color: COLORS.ink, fontSize: 16, fontWeight: "700", fontVariant: ["tabular-nums"] }, card: { backgroundColor: COLORS.card, borderRadius: 18, borderWidth: 1, borderColor: COLORS.line, padding: 18 }, cardTitle: { color: COLORS.ink, fontSize: 16, fontWeight: "700", marginBottom: 18 }, rowBetween: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }, budgetRow: { flexDirection: "row", alignItems: "flex-start" }, barWrap: { marginBottom: 15 }, barLine: { flexDirection: "row", justifyContent: "space-between", marginBottom: 7 }, barLabel: { color: COLORS.ink, fontSize: 13, fontWeight: "600" }, barAmount: { color: COLORS.muted, fontSize: 12, fontVariant: ["tabular-nums"] }, track: { height: 8, borderRadius: 4, backgroundColor: COLORS.pale, overflow: "hidden" }, fill: { height: "100%", borderRadius: 4, backgroundColor: COLORS.green }, overText: { color: COLORS.red, fontSize: 11, fontWeight: "600", marginTop: 5 }, empty: { alignItems: "center", gap: 10, paddingVertical: 20 }, emptyTitle: { color: COLORS.muted, fontSize: 13, textAlign: "center" }, emptyAction: { color: COLORS.green, fontWeight: "700", fontSize: 13 }, emptyText: { color: COLORS.muted, fontSize: 13, lineHeight: 20 }, transaction: { flexDirection: "row", alignItems: "center", paddingVertical: 10, borderBottomWidth: 1, borderBottomColor: COLORS.line, gap: 11 }, transactionIcon: { width: 35, height: 35, borderRadius: 12, backgroundColor: COLORS.pale, alignItems: "center", justifyContent: "center" }, transactionCopy: { flex: 1 }, transactionTitle: { color: COLORS.ink, fontWeight: "600", fontSize: 14 }, transactionSub: { color: COLORS.muted, fontSize: 12, marginTop: 3 }, transactionAmount: { fontWeight: "700", fontSize: 14, fontVariant: ["tabular-nums"] }, loader: { marginTop: 50 }, seeAll: { color: COLORS.green, fontWeight: "600", fontSize: 12 }, bottom: { position: "absolute", bottom: 0, left: 0, right: 0, height: 82, backgroundColor: "rgba(255,255,255,0.96)", borderTopWidth: 1, borderTopColor: COLORS.line, flexDirection: "row", justifyContent: "space-around", alignItems: "center", paddingHorizontal: 10 }, navItem: { minWidth: 55, minHeight: 48, justifyContent: "center", alignItems: "center", gap: 4 }, navLabel: { color: COLORS.muted, fontSize: 10, fontWeight: "600" }, navActive: { color: COLORS.green }, fab: { width: 54, height: 54, borderRadius: 27, backgroundColor: COLORS.green, alignItems: "center", justifyContent: "center", marginTop: -26, borderWidth: 5, borderColor: COLORS.bg }, modalShade: { flex: 1, backgroundColor: "rgba(28,28,30,0.38)", justifyContent: "flex-end" }, modal: { backgroundColor: COLORS.bg, borderTopLeftRadius: 26, borderTopRightRadius: 26, padding: 24, paddingBottom: 36, gap: 12 }, modalHead: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", marginBottom: 4 }, modalTitle: { color: COLORS.ink, fontSize: 22, fontWeight: "700" }, typeRow: { flexDirection: "row", gap: 10 }, type: { flex: 1, minHeight: 42, borderRadius: 12, borderWidth: 1, borderColor: COLORS.line, alignItems: "center", justifyContent: "center" }, typeExpense: { backgroundColor: "#F8E8E8", borderColor: COLORS.red }, typeIncome: { backgroundColor: COLORS.pale, borderColor: COLORS.green }, typeSavings: { backgroundColor: "#F7EFDD", borderColor: COLORS.gold }, typeText: { color: COLORS.ink, fontWeight: "600", fontSize: 13 }, inputLabel: { color: COLORS.muted, fontSize: 11, fontWeight: "700", letterSpacing: 1, marginTop: 5 }, input: { height: 48, borderRadius: 12, borderWidth: 1, borderColor: COLORS.line, backgroundColor: COLORS.card, paddingHorizontal: 14, color: COLORS.ink, fontSize: 16 }, chips: { gap: 8, paddingVertical: 2 }, chip: { borderRadius: 999, paddingVertical: 9, paddingHorizontal: 14, backgroundColor: COLORS.pale }, chipActive: { backgroundColor: COLORS.green }, chipText: { color: COLORS.green, fontSize: 12, fontWeight: "600" }, chipTextActive: { color: "#FFF" }, save: { minHeight: 50, borderRadius: 14, backgroundColor: COLORS.green, alignItems: "center", justifyContent: "center", marginTop: 8 }, saveText: { color: "#FFF", fontSize: 15, fontWeight: "700" }, remove: { minHeight: 44, alignItems: "center", justifyContent: "center" }, removeText: { color: COLORS.red, fontSize: 13, fontWeight: "600" }, actionBtn: { flexDirection: "row", alignItems: "center", gap: 12, minHeight: 52, borderRadius: 14, backgroundColor: COLORS.card, borderWidth: 1, borderColor: COLORS.line, paddingHorizontal: 16, marginTop: 6 }, actionBtnDanger: { borderColor: "#F1CFCF", backgroundColor: "#FFF6F6" }, actionText: { color: COLORS.ink, fontSize: 15, fontWeight: "600" }, flow: { height: 150, flexDirection: "row", alignItems: "flex-end", justifyContent: "center", gap: 30, borderBottomWidth: 1, borderBottomColor: COLORS.line }, flowBar: { width: 54, borderTopLeftRadius: 10, borderTopRightRadius: 10 }, flowLabels: { flexDirection: "row", justifyContent: "space-between", marginTop: 12 }, lowBalanceCard: { flexDirection: "row", alignItems: "center", gap: 12, backgroundColor: "#FDECEC", borderRadius: 16, padding: 14, borderWidth: 1, borderColor: "#F1CFCF" }, lowBalanceIcon: { width: 38, height: 38, borderRadius: 12, backgroundColor: "#F8DADA", alignItems: "center", justifyContent: "center" }, lowBalanceTitle: { color: COLORS.red, fontSize: 14, fontWeight: "700" }, lowBalanceSub: { color: "#8A4A4A", fontSize: 12, lineHeight: 17, marginTop: 3 }, ringCenter: { position: "absolute", alignItems: "center", justifyContent: "center" }, ringPct: { color: COLORS.ink, fontSize: 20, fontWeight: "700", fontVariant: ["tabular-nums"] }, cardTitleTight: { color: COLORS.ink, fontSize: 16, fontWeight: "700" }, goalCard: { flexDirection: "row", alignItems: "center", gap: 18, backgroundColor: COLORS.card, borderRadius: 18, borderWidth: 1, borderColor: COLORS.line, padding: 18 }, goalInfo: { flex: 1, gap: 4 }, goalHeadRow: { flexDirection: "row", justifyContent: "space-between", alignItems: "center" }, goalSaved: { color: COLORS.gold, fontSize: 20, fontWeight: "700", fontVariant: ["tabular-nums"] }, goalTarget: { color: COLORS.muted, fontSize: 14, fontWeight: "600" }, goalRemaining: { color: COLORS.muted, fontSize: 12, marginTop: 2 }, goalEmptyCard: { flexDirection: "row", alignItems: "center", gap: 12, backgroundColor: "#FBF6EC", borderRadius: 18, borderWidth: 1, borderColor: "#EAD9B6", padding: 16 }, goalEmptyIcon: { width: 40, height: 40, borderRadius: 13, backgroundColor: "#F3E6C9", alignItems: "center", justifyContent: "center" }, goalEmptySub: { color: "#8A7A52", fontSize: 12, lineHeight: 17, marginTop: 3 } });
