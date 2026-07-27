import { useState, useEffect } from "react";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import RouteScheduleDialog from "@/components/RouteScheduleDialog";
import { Plus, Eye } from "lucide-react";
import { RouteFormContext } from "@/components/Routes/RouteFormContext";
import { RouteDialog } from "@/components/Routes/RouteDialog";
import { RouteList } from "@/components/Routes/RouteList";
import { useRoutesState } from "@/components/Routes/useRoutesState";
import { ModelDiscoveryDialog } from "@/components/Routes/ModelDiscoveryDialog";

export default function RoutesPage() {
  const state = useRoutesState();
  const [discoveryOpen, setDiscoveryOpen] = useState(false);



  const contextValue = {
    dialogOpen: state.dialogOpen, setDialogOpen: state.setDialogOpen, editingId: state.editingId, handleSave: state.handleSave, formData: state.formData, setFormData: state.setFormData,
    providers: state.providers, handlePathChange: state.handlePathChange, handleProtocolChange: state.handleProtocolChange,
    policies: state.policies,
    groups: state.groups, usersForSelect: state.usersForSelect, closeDialog: state.closeDialog, getProviderProtocolForSelection: state.getProviderProtocolForSelection,
    allModels: state.allModels, getDefaultStrategyRules: state.getDefaultStrategyRules
  };

  return (
    <RouteFormContext.Provider value={contextValue}>
    <div className="space-y-6">
      <div className="flex justify-end items-center gap-2">
        <Button variant="outline" onClick={() => setDiscoveryOpen(true)}>
          <Eye className="h-4 w-4 mr-2" />
          {state.t("routes.modelDiscovery.title", "模型发现列表")}
        </Button>
        <Button onClick={state.openCreate}>
          <Plus className="h-4 w-4 mr-2" />
          {state.t("routes.actions.create", "新建路由")}
        </Button>
      </div>

      <RouteDialog />

      <ModelDiscoveryDialog open={discoveryOpen} onOpenChange={setDiscoveryOpen} />

      <RouteList 
        routes={state.routes} 
        providers={state.providers} 
        allModels={state.allModels}
        getReadinessBadge={state.getReadinessBadge} 
        toggleEnable={state.toggleEnable} 
        openEdit={state.openEdit} 
        openScheduleDialog={state.openScheduleDialog} 
        setDeleteConfirm={state.setDeleteConfirm} 
        openCreate={state.openCreate}
      />

      <ConfirmDialog
        open={state.deleteConfirm.open}
        onOpenChange={(open: boolean) => state.setDeleteConfirm({ ...state.deleteConfirm, open })}
        title={state.t("routes.deleteConfirm.title", "确认删除路由规则")}
        description={state.t("routes.deleteConfirm.description", { name: state.deleteConfirm.name })}
        confirmLabel={state.t("common.delete", "删除")}
        variant="destructive"
        onConfirm={state.handleDelete}
      />

      <RouteScheduleDialog
        open={state.scheduleDialogOpen}
        onOpenChange={state.setScheduleDialogOpen}
        route={state.selectedRouteForSchedule}
        providers={state.providers}
        policies={state.policies}
        onSuccess={state.loadData}
        allModels={state.allModels}
      />
    </div>
    </RouteFormContext.Provider>
  );
}
