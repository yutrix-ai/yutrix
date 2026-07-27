import { useState, useEffect } from "react";
import { fetchApi } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent } from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { FormField } from "@/components/FormField";
import { EmptyState } from "@/components/EmptyState";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { StatusBadge } from "@/components/StatusBadge";
import { KeyDisplay } from "@/components/KeyDisplay";
import { Users as UsersIcon, Plus, Trash2, Key, Eye, RefreshCw, Wand2, Edit2 } from "lucide-react";
import { toast } from "sonner";
import { useAuth } from "@/lib/store";
import { generateStrongPassword } from "@/lib/password";
import { useTranslation } from "react-i18next";
import { useTimeRange } from "@/contexts/TimeRangeContext";
import { useSettings } from "@/contexts/SettingsContext";

interface User {
  id: string;
  username: string;
  role: "admin" | "user";
  status: "active" | "disabled";
  createdAt: string;
  lastLoginAt: string | null;
  apiKeyCount: number;
  totalRequests: number;
  totalTokens: number;
  totalInputTokens?: number;
  totalOutputTokens?: number;
  totalCost?: number;
  maxInputTokensOverride?: number | null;
  effectiveMaxInputTokens?: number;
  effectiveMaxInputTokensSource?: string;
  effectiveMaxInputTokensSourceLabel?: string;
}

const initialFormData = {
  username: "",
  password: "",
  role: "user" as const,
};

export default function Users() {
  const { t } = useTranslation();
  const { user: currentUser } = useAuth();
  const { timeRangeQuery } = useTimeRange();
  const { formatToken, formatCost, formatDateTime } = useSettings();
  const [users, setUsers] = useState<User[]>([]);
  const [loading, setLoading] = useState(true);
  const [searchQuery, setSearchQuery] = useState("");
  const [createDialogOpen, setCreateDialogOpen] = useState(false);
  const [showPassword, setShowPassword] = useState(false);
  const [deleteConfirm, setDeleteConfirm] = useState<{
    open: boolean;
    userId: string | null;
    username: string;
  }>({ open: false, userId: null, username: "" });
  const [resetPasswordConfirm, setResetPasswordConfirm] = useState<{
    open: boolean;
    userId: string | null;
    username: string;
  }>({ open: false, userId: null, username: "" });
  const [newPassword, setNewPassword] = useState("");
  const [formData, setFormData] = useState(initialFormData);
  const [editUserDialogOpen, setEditUserDialogOpen] = useState(false);
  const [editingUser, setEditingUser] = useState<User | null>(null);
  const [editFormData, setEditFormData] = useState({
    role: "user",
    status: "active",
    maxInputTokensOverride: "",
  });

  useEffect(() => {
    loadData();
  }, [timeRangeQuery]);

  const loadData = async () => {
    setLoading(true);
    try {
      const data = await fetchApi(`/admin/users?${timeRangeQuery}`);
      setUsers(data);
    } catch (e: any) {
      toast.error(t("users.toasts.loadFailed", "加载用户列表失败") + ": " + e.message);
    } finally {
      setLoading(false);
    }
  };

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      await fetchApi("/admin/users", {
        method: "POST",
        body: JSON.stringify(formData),
      });
      toast.success(t("users.toasts.createSuccess", "用户创建成功"));
      setFormData(initialFormData);
      setCreateDialogOpen(false);
      loadData();
    } catch (e: any) {
      toast.error(t("users.toasts.createFailed", "创建失败") + ": " + e.message);
    }
  };

  const handleDeleteUser = async () => {
    if (!deleteConfirm.userId) return;
    try {
      await fetchApi(`/admin/users/${deleteConfirm.userId}`, {
        method: "DELETE",
        body: JSON.stringify({}),
      });
      toast.success(t("users.toasts.deleteSuccess", "用户已删除"));
      setDeleteConfirm({ open: false, userId: null, username: "" });
      loadData();
    } catch (e: any) {
      toast.error(t("users.toasts.deleteFailed", "删除失败") + ": " + e.message);
    }
  };

  const handleResetPassword = async () => {
    if (!resetPasswordConfirm.userId) return;
    try {
      const result = await fetchApi(
        `/admin/users/${resetPasswordConfirm.userId}/reset-password`,
        { 
          method: "POST",
          body: JSON.stringify({}) 
        }
      );
      setNewPassword(result.newPassword);
      toast.success(t("users.toasts.resetSuccess", "密码已重置"));
      loadData();
    } catch (e: any) {
      toast.error(t("users.toasts.resetFailed", "重置密码失败") + ": " + e.message);
    }
  };

  const handleCloseResetDialog = () => {
    setResetPasswordConfirm({ open: false, userId: null, username: "" });
    setNewPassword("");
  };

  const openEditUser = (user: User) => {
    setEditingUser(user);
    setEditFormData({
      role: user.role,
      status: user.status,
      maxInputTokensOverride:
        user.maxInputTokensOverride === null || user.maxInputTokensOverride === undefined
          ? ""
          : String(user.maxInputTokensOverride),
    });
    setEditUserDialogOpen(true);
  };

  const handleEditUser = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!editingUser) return;
    try {
      await fetchApi(`/admin/users/${editingUser.id}`, {
        method: "PATCH",
        body: JSON.stringify({
          role: editFormData.role,
          status: editFormData.status,
          maxInputTokensOverride:
            editFormData.maxInputTokensOverride.trim() === ""
              ? null
              : Number(editFormData.maxInputTokensOverride),
        }),
      });
      toast.success(t("users.toasts.updateSuccess", "用户已更新"));
      setEditUserDialogOpen(false);
      setEditingUser(null);
      loadData();
    } catch (e: any) {
      toast.error(t("users.toasts.updateFailed", "更新失败") + ": " + e.message);
    }
  };

  const formatInputLimit = (user: User) => {
    const effective = user.effectiveMaxInputTokens || 0;
    const value = effective > 0 ? formatToken(effective) : t("users.inputLimitUnlimited", "不限制");
    if (user.maxInputTokensOverride === null || user.maxInputTokensOverride === undefined) {
      return `${value} · ${t("users.inputLimitInherited", "继承")}`;
    }
    return `${value} · ${t("users.inputLimitOverride", "覆盖")}`;
  };

  const filteredUsers = users.filter(
    (u) =>
      u.username.toLowerCase().includes(searchQuery.toLowerCase())
  );

  if (loading) {
    return (
      <div className="space-y-4">
        <div className="flex justify-end items-center">
          <Skeleton className="h-10 w-32" />
        </div>
        <Card>
          <CardContent className="p-6">
            <div className="space-y-3">
              {[...Array(5)].map((_, i) => (
                <Skeleton key={i} className="h-12 w-full" />
              ))}
            </div>
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Header with Search and Create Button */}
      <div className="flex justify-between items-center gap-4">
        <div className="flex-1 max-w-sm">
          <Input
            placeholder={t("users.searchPlaceholder", "搜索用户名...")}
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
          />
        </div>
        <Dialog open={createDialogOpen} onOpenChange={setCreateDialogOpen}>
          <DialogTrigger asChild>
            <Button>
              <Plus className="h-4 w-4 mr-2" />
              {t("users.create", "创建用户")}
            </Button>
          </DialogTrigger>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>{t("users.createTitle", "创建新用户")}</DialogTitle>
              <DialogDescription>
                {t("users.createDesc", "创建一个新的用户账户")}
              </DialogDescription>
            </DialogHeader>
            <form onSubmit={handleCreate} noValidate autoComplete="off">
              <div className="space-y-4">
                <FormField label={t("users.username", "用户名")} required>
                  <Input
                    placeholder={t("users.usernamePlaceholder", "请输入用户名")}
                    value={formData.username}
                    onChange={(e) =>
                      setFormData({ ...formData, username: e.target.value })
                    }
                    required
                    autoFocus
                  />
                </FormField>

                <FormField label={t("users.password", "密码")} required>
                  <div className="flex gap-2">
                    <Input
                      type={showPassword ? "text" : "password"}
                      autoComplete="new-password"
                      placeholder={t("users.passwordPlaceholder", "至少8位，含大小写字母、数字及特殊字符")}
                      value={formData.password}
                      onChange={(e) =>
                        setFormData({ ...formData, password: e.target.value })
                      }
                      required
                      minLength={8}
                    />
                    <Button 
                      type="button" 
                      variant="outline" 
                      onClick={() => setShowPassword(!showPassword)}
                      title={showPassword ? t("users.hidePassword", "隐藏密码") : t("users.showPassword", "显示密码")}
                      className="px-3"
                    >
                      <Eye className="h-4 w-4" />
                    </Button>
                    <Button 
                      type="button" 
                      variant="outline" 
                      onClick={() => {
                        setFormData({ ...formData, password: generateStrongPassword() });
                        setShowPassword(true);
                      }}
                      title={t("users.generatePassword", "自动生成强密码")}
                      className="px-3"
                    >
                      <Wand2 className="h-4 w-4" />
                    </Button>
                  </div>
                </FormField>

                <FormField label={t("users.role", "角色")}>
                  <Select
                    value={formData.role}
                    onValueChange={(value: any) =>
                      setFormData({ ...formData, role: value })
                    }
                  >
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="user">{t("users.roleUser", "普通用户")}</SelectItem>
                      <SelectItem value="admin">{t("users.roleAdmin", "管理员")}</SelectItem>
                    </SelectContent>
                  </Select>
                </FormField>

                <DialogFooter>
                  <Button
                    type="button"
                    variant="outline"
                    onClick={() => {
                      setCreateDialogOpen(false);
                      setShowPassword(false);
                    }}
                  >
                    {t("common.cancel", "取消")}
                  </Button>
                  <Button type="submit">{t("common.create", "创建")}</Button>
                </DialogFooter>
              </div>
            </form>
          </DialogContent>
        </Dialog>
      </div>

      {/* Users Table */}
      <Card>
        <CardContent className="p-0">
          {filteredUsers.length === 0 ? (
            users.length === 0 ? (
              <EmptyState
                icon={<UsersIcon className="h-12 w-12" />}
                title={t("users.empty.title", "暂无用户")}
                description={t("users.empty.desc", "创建第一个用户账户")}
                action={{
                  label: t("users.create", "创建用户"),
                  onClick: () => setCreateDialogOpen(true),
                }}
              />
            ) : (
              <EmptyState
                icon={<UsersIcon className="h-12 w-12" />}
                title={t("users.empty.noResultsTitle", "未找到匹配的用户")}
                description={t("users.empty.noResultsDesc", "尝试使用其他关键词搜索")}
              />
            )
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t("users.username", "用户名")}</TableHead>
                  <TableHead>{t("users.role", "角色")}</TableHead>
                  <TableHead>{t("users.status", "状态")}</TableHead>
                  <TableHead>{t("users.apiKeys", "API Keys")}</TableHead>
                  <TableHead>{t("users.totalRequests", "总请求数")}</TableHead>
                  <TableHead>{t("users.totalTokens", "总 Tokens")}</TableHead>
                  <TableHead>{t("users.maxInputTokens", "输入限制")}</TableHead>
                  <TableHead>{t("common.cost", "费用")}</TableHead>
                  <TableHead>{t("users.lastLogin", "最后登录")}</TableHead>
                  <TableHead className="text-right">{t("users.actions", "操作")}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {filteredUsers.map((user) => (
                  <TableRow key={user.id}>
                    <TableCell className="font-medium">{user.username}</TableCell>
                    <TableCell>
                      <Badge
                        variant={user.role === "admin" ? "default" : "secondary"}
                      >
                        {user.role === "admin" ? t("users.roleAdmin", "管理员") : t("users.roleUser", "用户")}
                      </Badge>
                    </TableCell>
                    <TableCell>
                      <StatusBadge
                        status={user.status === "active" ? "active" : "disabled"}
                        label={user.status === "active" ? t("users.statusActive", "启用") : t("users.statusDisabled", "禁用")}
                      />
                    </TableCell>
                    <TableCell>{user.apiKeyCount}</TableCell>
                    <TableCell>{user.totalRequests.toLocaleString()}</TableCell>
                    <TableCell>
                      <div className="font-semibold">{formatToken(user.totalTokens)}</div>
                      <div className="text-xs text-muted-foreground mt-0.5">
                        {t("users.tokenBreakdownShort", "入: {{input}} / 出: {{output}}", {
                          input: formatToken(user.totalInputTokens || 0),
                          output: formatToken(user.totalOutputTokens || 0),
                        })}
                      </div>
                    </TableCell>
                    <TableCell className="text-sm">
                      {formatInputLimit(user)}
                    </TableCell>
                    <TableCell className="font-mono text-sm font-semibold text-foreground">
                      {user.totalCost != null ? formatCost(user.totalCost) : "-"}
                    </TableCell>
                    <TableCell className="text-muted-foreground text-sm">
                      {user.lastLoginAt
                        ? formatDateTime(user.lastLoginAt)
                        : t("users.neverLoggedIn", "从未登录")}
                    </TableCell>
                    <TableCell className="text-right">
                      <div className="flex justify-end gap-2">
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => openEditUser(user)}
                          title={t("common.edit", "编辑")}
                        >
                          <Edit2 className="h-4 w-4" />
                        </Button>
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() =>
                            setResetPasswordConfirm({
                              open: true,
                              userId: user.id,
                              username: user.username,
                            })
                          }
                          title={t("users.resetPassword", "重置密码")}
                        >
                          <RefreshCw className="h-4 w-4" />
                        </Button>
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() =>
                            setDeleteConfirm({
                              open: true,
                              userId: user.id,
                              username: user.username,
                            })
                          }
                          className="text-destructive hover:text-destructive"
                          title={t("common.delete", "删除")}
                          disabled={currentUser?.id === user.id}
                        >
                          <Trash2 className="h-4 w-4" />
                        </Button>
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      {/* Reset Password Dialog */}
      <Dialog open={editUserDialogOpen} onOpenChange={setEditUserDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("users.editTitle", "编辑用户")}</DialogTitle>
            <DialogDescription>
              {editingUser?.username}
            </DialogDescription>
          </DialogHeader>
          <form onSubmit={handleEditUser} className="space-y-4">
            <FormField label={t("users.role", "角色")}>
              <Select
                value={editFormData.role}
                onValueChange={(value) => setEditFormData({ ...editFormData, role: value })}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="user">{t("users.roleUser", "普通用户")}</SelectItem>
                  <SelectItem value="admin">{t("users.roleAdmin", "管理员")}</SelectItem>
                </SelectContent>
              </Select>
            </FormField>
            <FormField label={t("users.status", "状态")}>
              <Select
                value={editFormData.status}
                onValueChange={(value) => setEditFormData({ ...editFormData, status: value })}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="active">{t("users.statusActive", "启用")}</SelectItem>
                  <SelectItem value="disabled">{t("users.statusDisabled", "禁用")}</SelectItem>
                </SelectContent>
              </Select>
            </FormField>
            <FormField label={t("users.maxInputTokens", "最大输入 Token")}>
              <Input
                type="number"
                min={0}
                placeholder={t("users.maxInputTokensPlaceholder", "留空表示继承用户组，0 表示不限制")}
                value={editFormData.maxInputTokensOverride}
                onChange={(e) => setEditFormData({ ...editFormData, maxInputTokensOverride: e.target.value })}
              />
              <p className="text-xs text-muted-foreground mt-1">
                {t("users.maxInputTokensHint", "留空继承用户组；填 0 显式不限制；大于 0 时覆盖所有用户组限制。")}
              </p>
            </FormField>
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => setEditUserDialogOpen(false)}>
                {t("common.cancel", "取消")}
              </Button>
              <Button type="submit">{t("common.save", "保存")}</Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      <Dialog
        open={resetPasswordConfirm.open}
        onOpenChange={(open) => {
          if (!open) handleCloseResetDialog();
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("users.resetPassword", "重置密码")}</DialogTitle>
            <DialogDescription>
              {newPassword
                ? t("users.resetPasswordSuccessDesc", { username: resetPasswordConfirm.username })
                : t("users.resetPasswordConfirmDesc", { username: resetPasswordConfirm.username })}
            </DialogDescription>
          </DialogHeader>

          {newPassword ? (
            <div className="space-y-4">
              <KeyDisplay
                keyValue={newPassword}
                label={t("users.resetPasswordSuccessLabel", "新密码")}
                warning={t("users.resetPasswordSuccessWarning", "请立即保存此密码。关闭对话框后将无法再次查看！")}
              />
              <DialogFooter>
                <Button onClick={handleCloseResetDialog}>{t("common.confirm", "完成")}</Button>
              </DialogFooter>
            </div>
          ) : (
            <DialogFooter>
              <Button variant="outline" onClick={handleCloseResetDialog}>
                {t("common.cancel", "取消")}
              </Button>
              <Button onClick={handleResetPassword}>{t("users.resetPassword", "重置密码")}</Button>
            </DialogFooter>
          )}
        </DialogContent>
      </Dialog>

      {/* Delete Confirmation Dialog */}
      <ConfirmDialog
        open={deleteConfirm.open}
        onOpenChange={(open) => setDeleteConfirm({ ...deleteConfirm, open })}
        title={t("users.deleteTitle", "确认删除用户")}
        description={t("users.deleteDesc", { username: deleteConfirm.username })}
        confirmLabel={t("common.delete", "删除")}
        variant="destructive"
        onConfirm={handleDeleteUser}
      />
    </div>
  );
}
