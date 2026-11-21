package com.aid.greenroom;

import com.aid.domain.vo.AiModelConfigVo;
import com.aid.aid.domain.AidAiModel;
import com.aid.model.vo.AiModelVO;
import com.aid.aid.domain.model.ModelParameter;
import java.util.List;
import com.alibaba.fastjson2.JSON;
import java.util.Map;
import java.util.Collection;

/** Missing catalog parameters are omissions, never invented supported values. */
public final class GreenroomModelParameters {
    private GreenroomModelParameters() { }

    public static boolean undeclaredImage(AiModelConfigVo model, String scene, String options, String defaultKey) {
        return model != null && managed(model.getProviderCode()) && "greenroom-image".equals(model.getProtocol())
                && !parameterDeclared(model.getResolvedDefinition() == null ? null : model.getResolvedDefinition().getParameters(), options, "")
                && undeclared(model.getCapabilityJson(), scene, options, defaultKey,
                    "sizeOptions".equals(options) ? model.getDefaultSizeCode() : model.getDefaultAspectRatio());
    }

    public static void clearDisplay(AiModelVO view, AidAiModel model, String providerCode) {
        if (!managed(providerCode) || !java.util.Set.of("image", "video").contains(model.getModelType())) return;
        var cap = view.getCapability();
        if (cap == null) return;
        if (!parameterDeclared(view.getParameterSchema(), "sizeOptions", "") && undeclared(model.getCapabilityJson(), null, "sizeOptions", "defaultSize", model.getDefaultSizeCode())) {
            view.setSupportsSizePreset(false); view.setDefaultSizeCode(null); cap.setDefaultSize(null); cap.setSizeOptions(java.util.List.of());
        }
        if (!parameterDeclared(view.getParameterSchema(), "aspectRatioOptions", "") && undeclared(model.getCapabilityJson(), null, "aspectRatioOptions", "defaultAspectRatio", model.getDefaultAspectRatio())) {
            view.setSupportsAspectRatio(false); view.setDefaultAspectRatio(null); cap.setDefaultAspectRatio(null); cap.setAspectRatioOptions(java.util.List.of());
        }
        if ("video".equals(model.getModelType()) && !parameterDeclared(view.getParameterSchema(), "durationOptions", "") && undeclared(model.getCapabilityJson(), null, "durationOptions", "defaultDurationSeconds", model.getDefaultDurationSeconds())) {
            view.setSupportsDuration(false); view.setDefaultDurationSeconds(null); cap.setDefaultDurationSeconds(null); cap.setDurationOptions(java.util.List.of());
        }
    }

    private static boolean parameterDeclared(List<ModelParameter> parameters, String option, String prefix) {
        if (parameters == null) return false;
        var names = "sizeOptions".equals(option) ? java.util.Set.of("size", "options.size", "options.resolution")
                : "aspectRatioOptions".equals(option) ? java.util.Set.of("aspectRatio", "options.aspectRatio") : java.util.Set.of("durationSeconds");
        for (var parameter : parameters) {
            String name = prefix + parameter.getName();
            if (names.contains(name) || parameterDeclared(parameter.getProperties(), option, name + ".")) return true;
        }
        return false;
    }

    private static boolean managed(String providerCode) {
        return "true".equals(System.getenv("GREENROOM_MANAGED")) && "greenroom".equals(providerCode);
    }

    private static boolean undeclared(String json, String scene, String options, String defaultKey, Object modelDefault) {
        if (present(modelDefault) || json == null || json.isBlank()) return false;
        Map<?, ?> cap = JSON.parseObject(json);
        if (declared(cap, options, defaultKey)) return false;
        Object raw = cap.get("sceneRules");
        if (raw != null && !(raw instanceof Map<?, ?>)) return false;
        if (raw instanceof Map<?, ?> scenes) {
            if (scene != null) {
                Object value = scenes.get(scene);
                if (value != null && !(value instanceof Map<?, ?>)) return false;
                if (value instanceof Map<?, ?> scoped && declared(scoped, options, defaultKey)) return false;
            } else {
                for (Object value : scenes.values()) {
                    if (value != null && !(value instanceof Map<?, ?>)) return false;
                    if (value instanceof Map<?, ?> scoped && declared(scoped, options, defaultKey)) return false;
                }
            }
        }
        return true;
    }

    private static boolean declared(Map<?, ?> values, String options, String defaultKey) {
        Object choices = values.get(options);
        if ("sizeOptions".equals(options) && Boolean.TRUE.equals(values.get("allowCustomWH"))) return true;
        // Malformed declarations are not an omission exception: keep the native strict path.
        return choices != null && (!(choices instanceof Collection<?> rows) || !rows.isEmpty()) || present(values.get(defaultKey));
    }

    private static boolean present(Object value) { return value != null && (!(value instanceof String text) || !text.isBlank()); }
}
