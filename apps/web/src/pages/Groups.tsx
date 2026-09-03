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
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
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
import { EmptyState } from "@/components/EmptyState";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { Users as GroupsIcon, Plus, Trash2, Edit2, UserPlus, UserMinus } from "lucide-react";
import { toast } from "sonner";
import { useTranslation } from "react-i18next";

interface Group {
  id: string;
  name: string;
  description: string | null;
  isDefault: boolean;
  maxInputTokens: number;
  memberCount: number;
  createdAt: string;
  updatedAt: string;
}

interface GroupMember {
  id: string;
  userId: string;
  username: string | null;
  role: string | null;
  status: string | null;
  joinedAt: string;
  effectiveMaxInputTokens?: number;
  effectiveMaxInputTokensSource?: string;
  effectiveMaxInputTokensSourceLabel?: string;
}

interface UserOption {
  id: string;
  username: string;
  role: string;
  status: string;
}

function getGroupDisplayName(group: Group, t: any): string {
  if (group.isDefault) return t("groups.defaultGroupName", "默认组");
  return group.name;
}

function getGroupDisplayDesc(group: Group, t: any): string {
  if (group.isDefault) return t("groups.defaultGroupDesc", "系统默认用户组，包含所有普通用户");
  return group.description || "-";
}

function formatTokenLimit(value: number | null | undefined, t: any): string {
  return value && value > 0 ? value.toLocaleString() : t("groups.unlimited", "不限制");
}

export default function Groups() {
  const { t } = useTranslation();
  const [groups, setGroups] = useState<Group[]>([]);
  const [loading, setLoading] = useState(true);
  const [createDialogOpen, setCreateDialogOpen] = useState(false);
  const [editDialogOpen, setEditDialogOpen] = useState(false);
  const [editingGroup, setEditingGroup] = useState<Group | null>(null);
  const [deleteConfirm, setDeleteConfirm] = useState<{ open: boolean; groupId: string | null; groupName: string }>({
    open: false,
    groupId: null,
    groupName: "",
  });
  const [membersDialogOpen, setMembersDialogOpen] = useState(false);
  const [membersGroup, setMembersGroup] = useState<Group | null>(null);
  const [members, setMembers] = useState<GroupMember[]>([]);
  const [loadingMembers, setLoadingMembers] = useState(false);
  const [allUsers, setAllUsers] = useState<UserOption[]>([]);
  const [addUserDialogOpen, setAddUserDialogOpen] = useState(false);
  const [selectedUserId, setSelectedUserId] = useState("");

  const [formData, setFormData] = useState({ name: "", description: "", maxInputTokens: "0" });
  const [editFormData, setEditFormData] = useState({ name: "", description: "", maxInputTokens: "0" });

  useEffect(() => {
    loadData();
  }, []);

  const loadData = async () => {
    setLoading(true);
    try {
      const data = await fetchApi("/admin/groups");
      setGroups(data);
    } catch (e: any) {
      toast.error(t("groups.toasts.loadFailed", "加载用户组失败") + ": " + e.message);
    } finally {
      setLoading(false);
    }
  };

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      await fetchApi("/admin/groups", {
        method: "POST",
        body: JSON.stringify({
          ...formData,
          maxInputTokens: Number(formData.maxInputTokens || 0),
        }),
      });
      toast.success(t("groups.toasts.createSuccess", "用户组创建成功"));
      setFormData({ name: "", description: "", maxInputTokens: "0" });
      setCreateDialogOpen(false);
      loadData();
    } catch (e: any) {
      toast.error(t("groups.toasts.createFailed", "创建失败") + ": " + e.message);
    }
  };

  const handleEdit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!editingGroup) return;
    try {
      await fetchApi(`/admin/groups/${editingGroup.id}`, {
        method: "PATCH",
        body: JSON.stringify({
          ...editFormData,
          maxInputTokens: Number(editFormData.maxInputTokens || 0),
        }),
      });
      toast.success(t("groups.toasts.updateSuccess", "用户组更新成功"));
      setEditDialogOpen(false);
      loadData();
    } catch (e: any) {
      toast.error(t("groups.toasts.updateFailed", "更新失败") + ": " + e.message);
    }
  };

  const handleDelete = async () => {
    if (!deleteConfirm.groupId) return;
    try {
      await fetchApi(`/admin/groups/${deleteConfirm.groupId}`, {
        method: "DELETE",
        body: "{}",
      });
      toast.success(t("groups.toasts.deleteSuccess", "用户组已删除"));
      setDeleteConfirm({ open: false, groupId: null, groupName: "" });
      loadData();
    } catch (e: any) {
      toast.error(t("groups.toasts.deleteFailed", "删除失败") + ": " + e.message);
    }
  };

  const openMembers = async (group: Group) => {
    setMembersGroup(group);
    setMembersDialogOpen(true);
    setLoadingMembers(true);
    try {
      const [membersData, usersData] = await Promise.all([
        fetchApi(`/admin/groups/${group.id}/members`),
        fetchApi("/admin/groups/users-for-select"),
      ]);
      setMembers(membersData);
      setAllUsers(usersData.filter((u: UserOption) => u.role === "user" && u.status !== "deleted"));
    } catch (e: any) {
      toast.error(t("groups.toasts.loadMembersFailed", "加载成员失败") + ": " + e.message);
    } finally {
      setLoadingMembers(false);
    }
  };

  const handleAddMember = async (userIdOverride?: string) => {
    const userId = userIdOverride || selectedUserId;
    if (!membersGroup || !userId) return;
    try {
      const res = await fetchApi(`/admin/groups/${membersGroup.id}/members`, {
        method: "POST",
        body: JSON.stringify({ userId }),
      });
      if (res?.moved) {
        toast.success(t("groups.toasts.moveMemberSuccess", "已移动到该组"));
      } else {
        toast.success(t("groups.toasts.addMemberSuccess", "成员已添加"));
      }
      setSelectedUserId("");
      setAddUserDialogOpen(false);
      const membersData = await fetchApi(`/admin/groups/${membersGroup.id}/members`);
      setMembers(membersData);
      loadData();
    } catch (e: any) {
      toast.error(t("groups.toasts.addMemberFailed", "添加成员失败") + ": " + e.message);
    }
  };

  const handleRemoveMember = async (userId: string) => {
    if (!membersGroup) return;
    try {
      await fetchApi(`/admin/groups/${membersGroup.id}/members/${userId}`, {
        method: "DELETE",
        body: "{}",
      });
      toast.success(t("groups.toasts.removeMemberSuccess", "成员已移除"));
      const membersData = await fetchApi(`/admin/groups/${membersGroup.id}/members`);
      setMembers(membersData);
      loadData();
    } catch (e: any) {
      toast.error(t("groups.toasts.removeMemberFailed", "移除成员失败") + ": " + e.message);
    }
  };

  const openEdit = (group: Group) => {
    setEditingGroup(group);
    setEditFormData({
      name: group.name,
      description: group.description || "",
      maxInputTokens: String(group.maxInputTokens || 0),
    });
    setEditDialogOpen(true);
  };

  const availableUsers = allUsers.filter(
    (u) => !members.some((m) => m.userId === u.id)
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
              {[...Array(3)].map((_, i) => (
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
      <div className="flex justify-between items-center gap-4">
        <div className="flex-1" />
        <Button onClick={() => { setFormData({ name: "", description: "", maxInputTokens: "0" }); setCreateDialogOpen(true); }}>
          <Plus className="h-4 w-4 mr-2" />
          {t("groups.create", "创建用户组")}
        </Button>
      </div>

      <Card>
        <CardContent className="p-0">
          {groups.length === 0 ? (
            <EmptyState
              icon={<GroupsIcon className="h-12 w-12" />}
              title={t("groups.empty.title", "暂无用户组")}
              description={t("groups.empty.desc", "创建一个用户组来管理用户权限")}
              action={{ label: t("groups.create", "创建用户组"), onClick: () => setCreateDialogOpen(true) }}
            />
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t("groups.table.name", "组名")}</TableHead>
                  <TableHead>{t("groups.table.description", "描述")}</TableHead>
                  <TableHead>{t("groups.table.members", "成员数")}</TableHead>
                  <TableHead>{t("groups.table.maxInputTokens", "输入限制")}</TableHead>
                  <TableHead>{t("groups.table.type", "类型")}</TableHead>
                  <TableHead className="text-right">{t("groups.table.actions", "操作")}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {groups.map((group) => (
                  <TableRow key={group.id}>
                    <TableCell className="font-medium">{getGroupDisplayName(group, t)}</TableCell>
                    <TableCell className="text-muted-foreground">{getGroupDisplayDesc(group, t)}</TableCell>
                    <TableCell>
                      <Badge variant="secondary">{group.memberCount}</Badge>
                    </TableCell>
                    <TableCell className="font-mono text-sm">
                      {formatTokenLimit(group.maxInputTokens, t)}
                    </TableCell>
                    <TableCell>
                      {group.isDefault ? (
                        <Badge>{t("groups.defaultBadge", "默认组")}</Badge>
                      ) : (
                        <Badge variant="outline">{t("groups.customBadge", "自定义")}</Badge>
                      )}
                    </TableCell>
                    <TableCell className="text-right">
                      <div className="flex justify-end gap-2">
                        <Button variant="ghost" size="sm" onClick={() => openMembers(group)} title={t("groups.manageMembers", "管理成员")}>
                          <GroupsIcon className="h-4 w-4" />
                        </Button>
                        <Button variant="ghost" size="sm" onClick={() => openEdit(group)}>
                          <Edit2 className="h-4 w-4" />
                        </Button>
                        {!group.isDefault && (
                          <>
                            <Button
                              variant="ghost"
                              size="sm"
                              className="text-destructive"
                              onClick={() => setDeleteConfirm({ open: true, groupId: group.id, groupName: getGroupDisplayName(group, t) })}
                            >
                              <Trash2 className="h-4 w-4" />
                            </Button>
                          </>
                        )}
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      <Dialog open={createDialogOpen} onOpenChange={setCreateDialogOpen}>
        <DialogContent className="sm:max-w-xl">
          <DialogHeader>
            <DialogTitle>{t("groups.createTitle", "创建新用户组")}</DialogTitle>
            <DialogDescription>{t("groups.createDesc", "创建一个新的用户组来管理路由权限")}</DialogDescription>
          </DialogHeader>
          <form onSubmit={handleCreate} className="space-y-4">
            <div className="space-y-2">
              <Label>{t("groups.name", "组名")}</Label>
              <Input value={formData.name} onChange={(e) => setFormData({ ...formData, name: e.target.value })} required autoFocus />
            </div>
            <div className="space-y-2">
              <Label>{t("groups.description", "描述")}</Label>
              <Input value={formData.description} onChange={(e) => setFormData({ ...formData, description: e.target.value })} />
            </div>
            <div className="space-y-2">
              <Label>{t("groups.maxInputTokens", "最大输入 Token")}</Label>
              <Input
                type="number"
                min={0}
                value={formData.maxInputTokens}
                onChange={(e) => setFormData({ ...formData, maxInputTokens: e.target.value })}
              />
              <p className="text-xs text-muted-foreground">{t("groups.maxInputTokensHint", "填 0 表示不限制。用户未单独覆盖时继承该值。")}</p>
            </div>
            <DialogFooter>
              <Button type="button" variant="ghost" onClick={() => setCreateDialogOpen(false)}>{t("common.cancel", "取消")}</Button>
              <Button type="submit">{t("common.create", "创建")}</Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      <Dialog open={editDialogOpen} onOpenChange={setEditDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("groups.editTitle", "编辑用户组")}</DialogTitle>
            <DialogDescription>{t("groups.editDesc", "修改用户组信息")}</DialogDescription>
          </DialogHeader>
          <form onSubmit={handleEdit} className="space-y-4">
            <div className="space-y-2">
              <Label>{t("groups.name", "组名")}</Label>
              <Input value={editFormData.name} onChange={(e) => setEditFormData({ ...editFormData, name: e.target.value })} required autoFocus disabled={editingGroup?.isDefault} />
            </div>
            <div className="space-y-2">
              <Label>{t("groups.description", "描述")}</Label>
              <Input value={editFormData.description} onChange={(e) => setEditFormData({ ...editFormData, description: e.target.value })} disabled={editingGroup?.isDefault} />
            </div>
            <div className="space-y-2">
              <Label>{t("groups.maxInputTokens", "最大输入 Token")}</Label>
              <Input
                type="number"
                min={0}
                value={editFormData.maxInputTokens}
                onChange={(e) => setEditFormData({ ...editFormData, maxInputTokens: e.target.value })}
              />
              <p className="text-xs text-muted-foreground">{t("groups.maxInputTokensHint", "填 0 表示不限制。用户未单独覆盖时继承该值。")}</p>
            </div>
            <DialogFooter>
              <Button type="button" variant="ghost" onClick={() => setEditDialogOpen(false)}>{t("common.cancel", "取消")}</Button>
              <Button type="submit">{t("common.save", "保存")}</Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      <Dialog open={membersDialogOpen} onOpenChange={setMembersDialogOpen}>
        <DialogContent className="sm:max-w-2xl h-[70vh] flex flex-col">
          <DialogHeader>
            <DialogTitle>{t("groups.membersTitle", "管理成员")} - {membersGroup ? getGroupDisplayName(membersGroup, t) : ""}</DialogTitle>
            <DialogDescription>{t("groups.membersDesc", "添加或移除该组的成员（用户最多属于一个组，添加时自动移出原所在组）")}</DialogDescription>
          </DialogHeader>
          <DialogBody className="py-4">
            <div className="flex justify-end mb-4">
              <Button size="sm" onClick={() => { setSelectedUserId(""); setAddUserDialogOpen(true); }}>
                <UserPlus className="h-4 w-4 mr-1" />
                {t("groups.addMember", "添加成员")}
              </Button>
            </div>
            {loadingMembers ? (
              <div className="space-y-2">
                {[...Array(3)].map((_, i) => <Skeleton key={i} className="h-10 w-full" />)}
              </div>
            ) : members.length === 0 ? (
              <div className="text-center text-muted-foreground py-6 text-sm">
                {t("groups.noMembers", "该组暂无成员")}
              </div>
            ) : (
              <div className="space-y-2">
                {members.map((member) => (
                  <div key={member.id} className="flex items-center justify-between p-2 border rounded-md">
                    <div>
                      <div className="text-sm font-medium">{member.username || member.userId}</div>
                      <div className="text-xs text-muted-foreground">
                        {member.role === "admin" ? t("users.roleAdmin", "管理员") : t("users.roleUser", "用户")}
                      </div>
                      <div className="text-xs text-muted-foreground mt-1">
                        {t("groups.effectiveInputLimit", "有效输入限制")}: {formatTokenLimit(member.effectiveMaxInputTokens, t)}
                      </div>
                    </div>
                    <Button variant="ghost" size="sm" className="text-destructive" onClick={() => handleRemoveMember(member.userId)}>
                      <UserMinus className="h-4 w-4" />
                    </Button>
                  </div>
                ))}
              </div>
            )}
          </DialogBody>
          <DialogFooter className="pt-4 border-t">
            <Button variant="ghost" onClick={() => setMembersDialogOpen(false)}>{t("common.close", "关闭")}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={addUserDialogOpen} onOpenChange={setAddUserDialogOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{t("groups.addMemberTitle", "添加 / 移动成员")}</DialogTitle>
            <DialogDescription>{t("groups.addMemberDesc", "选择要加入该组的用户（若已在其他组将自动移出）")}</DialogDescription>
          </DialogHeader>
          <div className="pt-2">
            {availableUsers.length === 0 ? (
              <div className="text-center text-muted-foreground py-8 text-sm">
                {t("groups.noAvailableUsers", "没有可添加的用户")}
              </div>
            ) : (
              <div className="space-y-1.5 max-h-72 overflow-y-auto">
                {availableUsers.map((u) => (
                  <div
                    key={u.id}
                    onClick={() => handleAddMember(u.id)}
                    className="flex items-center gap-3 px-3 py-2.5 rounded-md border cursor-pointer hover:bg-accent hover:text-accent-foreground transition-colors"
                  >
                    <div className="flex h-8 w-8 items-center justify-center rounded-full bg-primary/10 text-primary text-sm font-semibold shrink-0">
                      {u.username.charAt(0).toUpperCase()}
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="text-sm font-medium truncate">{u.username}</div>
                      <div className="text-xs text-muted-foreground truncate">{t("groups.moveHint", "选择后将自动移出原所在组")}</div>
                    </div>
                    <UserPlus className="h-4 w-4 text-muted-foreground" />
                  </div>
                ))}
              </div>
            )}
          </div>
        </DialogContent>
      </Dialog>

      <ConfirmDialog
        open={deleteConfirm.open}
        onOpenChange={(open) => setDeleteConfirm({ ...deleteConfirm, open })}
        title={t("groups.deleteTitle", "确认删除用户组")}
        description={t("groups.deleteDesc", { name: deleteConfirm.groupName })}
        confirmLabel={t("common.delete", "删除")}
        variant="destructive"
        onConfirm={handleDelete}
      />
    </div>
  );
}
