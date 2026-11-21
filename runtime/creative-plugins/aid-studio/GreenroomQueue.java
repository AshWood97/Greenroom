package com.aid.greenroom;

import com.alibaba.fastjson2.JSON;
import com.alibaba.fastjson2.JSONObject;
import com.aid.common.exception.ServiceException;
import com.aid.common.utils.SecurityUtils;
import com.aid.domain.vo.AiModelConfigVo;
import com.aid.media.provider.ProviderTaskResult;
import jakarta.annotation.PostConstruct;
import java.util.*;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

/** Durable handoff between AID's original workers and the owning member's MCP host. */
@Service
public class GreenroomQueue {
    private final JdbcTemplate jdbc;
    public GreenroomQueue(JdbcTemplate jdbc) { this.jdbc = jdbc; }
    public void health() { jdbc.queryForObject("SELECT COUNT(*) FROM greenroom_members",Long.class); }
    public Long defaultModel(String type,Long owner) {
        List<Long> ids=jdbc.queryForList("SELECT m.id FROM greenroom_member_models g JOIN aid_ai_model m ON m.id=g.model_id WHERE g.user_id=? AND m.model_type=? AND m.status='0' ORDER BY g.sort_order LIMIT 1",Long.class,owner,type);
        return ids.isEmpty()?null:ids.get(0);
    }
    public void requireModel(Long model,Long owner) {
        Integer count=jdbc.queryForObject("SELECT COUNT(*) FROM greenroom_member_models WHERE model_id=? AND user_id=?",Integer.class,model,owner);
        if(count==null||count==0) throw new ServiceException("管理员未批准该模型");
    }

    @PostConstruct
    public void initialize() {
        if (!"true".equals(System.getenv("GREENROOM_MANAGED"))) return;
        jdbc.execute("CREATE TABLE IF NOT EXISTS greenroom_members (member_id VARCHAR(255) PRIMARY KEY, user_id BIGINT NOT NULL UNIQUE)");
        jdbc.execute("CREATE TABLE IF NOT EXISTS greenroom_member_models (user_id BIGINT NOT NULL, model_id BIGINT NOT NULL, sort_order INT NOT NULL, PRIMARY KEY(user_id,model_id))");
        jdbc.execute("CREATE TABLE IF NOT EXISTS greenroom_submissions (id VARCHAR(96) PRIMARY KEY, user_id BIGINT NOT NULL, kind VARCHAR(16) NOT NULL, body LONGTEXT NOT NULL, status VARCHAR(24) NOT NULL DEFAULT 'pending', provider_task_id VARCHAR(255), result LONGTEXT, query_error TEXT, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP, INDEX owner_status (user_id,status))");
    }

    public String submit(String id, String kind, Long owner, Map<String,Object> body) {
        if (owner == null) owner = SecurityUtils.getUserId();
        if (id == null || id.isBlank()) throw new ServiceException("AID 未提供可恢复的业务任务编号");
        jdbc.update("INSERT IGNORE INTO greenroom_submissions(id,user_id,kind,body) VALUES (?,?,?,?)", id, owner, kind, JSON.toJSONString(body));
        Map<String,Object> existing = jdbc.queryForMap("SELECT user_id FROM greenroom_submissions WHERE id=?", id);
        if (((Number)existing.get("user_id")).longValue() != owner.longValue()) throw new ServiceException("任务归属不匹配");
        return id;
    }

    public List<Map<String,Object>> pending(Long owner, String after) {
        String sql = "SELECT s.id,s.kind,s.body,s.status,s.provider_task_id,s.query_error FROM greenroom_submissions s "
            + (after == null ? "" : "JOIN greenroom_submissions a ON a.id=? AND a.user_id=s.user_id ")
            + "WHERE s.user_id=? AND s.status IN ('pending','processing') "
            + (after == null ? "" : "AND (s.created_at>a.created_at OR (s.created_at=a.created_at AND s.id>a.id)) ")
            + "ORDER BY s.created_at,s.id LIMIT 100";
        return jdbc.query(sql, (rs, row) -> {
            Map<String,Object> value = new LinkedHashMap<>();
            value.put("id", rs.getString("id")); value.put("kind", rs.getString("kind"));
            value.put("body", JSON.parseObject(rs.getString("body")));
            value.put("status", rs.getString("status")); value.put("providerTaskId", rs.getString("provider_task_id"));
            value.put("queryError", rs.getString("query_error"));
            return value;
        }, after == null ? new Object[]{owner} : new Object[]{after,owner});
    }

    public void update(Long owner, Map<String,Object> value) {
        String id = Objects.toString(value.get("id"), "");
        List<Map<String,Object>> rows = jdbc.queryForList("SELECT status,provider_task_id FROM greenroom_submissions WHERE id=? AND user_id=?", id, owner);
        if (rows.isEmpty()) throw new ServiceException("任务不存在或无权访问");
        Map<String,Object> previous = rows.get(0);
        String accepted = Objects.toString(value.get("providerTaskId"), "");
        String known = Objects.toString(previous.get("provider_task_id"), "");
        if (!known.isEmpty() && !accepted.isEmpty() && !known.equals(accepted)) throw new ServiceException("已受理任务不能替换上游任务编号");
        if (value.containsKey("queryError")) {
            jdbc.update("UPDATE greenroom_submissions SET query_error=? WHERE id=? AND user_id=?", Objects.toString(value.get("queryError"), ""), id, owner);
            return;
        }
        String status = Objects.toString(value.get("status"), "processing");
        if (!Set.of("processing", "succeeded", "failed", "cancelled").contains(status)) throw new ServiceException("未知托管任务状态");
        if (Set.of("succeeded", "failed", "cancelled").contains(Objects.toString(previous.get("status")))) return;
        jdbc.update("UPDATE greenroom_submissions SET status=?,provider_task_id=COALESCE(provider_task_id,?),result=?,query_error=NULL WHERE id=? AND user_id=?",
            status, accepted.isEmpty() ? null : accepted, JSON.toJSONString(value), id, owner);
    }

    public JSONObject result(String id) {
        List<Map<String,Object>> rows = jdbc.queryForList("SELECT status,result,query_error FROM greenroom_submissions WHERE id=?", id);
        if (rows.isEmpty()) throw new ServiceException("原托管任务不存在");
        Map<String,Object> row = rows.get(0);
        JSONObject result = row.get("result") == null ? new JSONObject() : JSON.parseObject(row.get("result").toString());
        result.put("status", row.get("status"));
        result.put("queryError", row.get("query_error"));
        return result;
    }

    public Map<String,Object> owned(Long owner, String id) {
        List<Map<String,Object>> rows = jdbc.queryForList("SELECT id,body,status,result FROM greenroom_submissions WHERE id=? AND user_id=?", id, owner);
        if (rows.isEmpty()) throw new ServiceException("任务不存在或无权访问");
        return rows.get(0);
    }

    public ProviderTaskResult query(String id) {
        JSONObject task = result(id);
        String status = task.getString("status");
        if ("succeeded".equals(status)) {
            List<String> urls = new ArrayList<>();
            List<String> mimeTypes = new ArrayList<>();
            for (Object raw : task.getJSONArray("outputs")) {
                JSONObject output = JSON.parseObject(JSON.toJSONString(raw));
                urls.add(output.getString("url")); mimeTypes.add(output.getString("mimeType"));
            }
            if (urls.isEmpty()) throw new ServiceException("平台未返回生成产物");
            return ProviderTaskResult.builder().status("SUCCEEDED").querySuccessful(true).terminalConfirmed(true)
                .resultUrl(urls.get(0)).resultUrls(urls).persistedResultUrls(urls).persistedResultMimeTypes(mimeTypes)
                .resultCount(urls.size()).build();
        }
        if (Set.of("failed", "cancelled").contains(status)) {
            return ProviderTaskResult.builder().status("FAILED").querySuccessful(true).terminalConfirmed(true)
                .errorMessage(Objects.toString(task.get("error"), "服务商未返回具体失败原因")).build();
        }
        return ProviderTaskResult.builder().status("PROCESSING").querySuccessful(task.get("queryError") == null)
            .terminalConfirmed(false).errorMessage(task.getString("queryError")).build();
    }

    @Transactional
    public void syncModels(Map<String,List<Map<String,Object>>> catalog) {
        Long owner = SecurityUtils.getUserId();
        jdbc.update("INSERT INTO aid_ai_provider(provider_name,provider_code,base_url,api_key,status,del_flag) VALUES ('Greenroom 管理员托管','greenroom','http://127.0.0.1:18807/greenroom','greenroom-managed','0','0') ON DUPLICATE KEY UPDATE status='0'");
        Long provider = jdbc.queryForObject("SELECT id FROM aid_ai_provider WHERE provider_code='greenroom' LIMIT 1", Long.class);
        jdbc.update("UPDATE aid_ai_model SET status='1' WHERE provider_id<>?", provider);
        jdbc.update("DELETE FROM greenroom_member_models WHERE user_id=?", owner);
        for (String kind : List.of("llm", "image", "video", "tts", "music")) {
            String type = kind.equals("llm") ? "text" : Set.of("tts","music").contains(kind) ? "audio" : kind;
            List<Long> ids = new ArrayList<>();
            for (Map<String,Object> model : catalog.getOrDefault(kind, List.of())) {
                String upstream = Objects.toString(model.get("id"), "");
                if (upstream.isEmpty()) continue;
                List<Long> found = jdbc.queryForList("SELECT id FROM aid_ai_model WHERE provider_id=? AND real_model_code=? AND model_type=? LIMIT 1", Long.class, provider, upstream, type);
                String code = found.isEmpty() ? "gr_" + UUID.randomUUID().toString().replace("-", "") : null;
                if (found.isEmpty()) {
                    String name = type.equals("image") ? imageLabel(model, catalog.getOrDefault("image", List.of())) : Objects.toString(model.get("name"), "");
                    jdbc.update("INSERT INTO aid_ai_model(provider_id,model_code,real_model_code,model_name,model_type,generate_mode,protocol,api_suffix,cost_credits,billing_multiplier,billing_mode,is_free,status,del_flag,priority,supports_image_input,supports_multi_image_input,supports_aspect_ratio,supports_duration,supports_first_frame,max_output_count,default_output_count) VALUES (?,?,?,?,?,?,?,?,0,1,'FIXED',1,'0','0',100,1,1,1,?,1,1,1)",
                        provider, code, upstream, name.isEmpty() ? upstream : name, type,
                        type.equals("text") ? "text" : type.equals("audio") ? "audio" : type.equals("image") ? "text_to_image" : "text_to_video",
                        "greenroom-" + type, "/managed", type.equals("video") ? 1 : 0);
                    found = jdbc.queryForList("SELECT id FROM aid_ai_model WHERE model_code=?", Long.class, code);
                } else {
                    jdbc.update("UPDATE aid_ai_model SET status='0',is_free=1 WHERE id=?", found.get(0));
                    if (type.equals("image")) {
                        String name = imageLabel(model, catalog.getOrDefault("image", List.of()));
                        if (!name.isEmpty()) jdbc.update("UPDATE aid_ai_model SET model_name=? WHERE id=?", name, found.get(0));
                    }
                }
                Map<String,Object> scenes=new LinkedHashMap<>();
                if(type.equals("image")) for(String scene:List.of("textToImage","imageToImage")) scenes.put(scene,Map.of());
                if(type.equals("video")) for(String scene:List.of("textToVideo","imageToVideo","startEndToVideo","referenceToVideo")) scenes.put(scene,Map.of());
                jdbc.update("UPDATE aid_ai_model SET generate_mode=?,capability_json=? WHERE id=?",type.equals("audio")?"audio":type.equals("text")?"text":type.equals("image")?"text_to_image":"text_to_video",JSON.toJSONString(scenes.isEmpty()?Map.of():Map.of("sceneRules",scenes)),found.get(0));
                ids.add(found.get(0));
                jdbc.update("INSERT INTO greenroom_member_models(user_id,model_id,sort_order) VALUES (?,?,?)", owner, found.get(0), ids.size());
            }
            List<Long> allIds = jdbc.queryForList("SELECT id FROM aid_ai_model WHERE provider_id=? AND model_type=? AND status='0' ORDER BY id", Long.class, provider, type);
            jdbc.update("UPDATE aid_ai_model_func_config SET model_ids=? WHERE model_type=?", JSON.toJSONString(allIds), type);
        }
    }

    /** Managed image entries carry the central catalog label; a missing one keeps the original id fallback. */
    private String imageLabel(Map<String,Object> model, List<Map<String,Object>> images) {
        String label = Objects.toString(model.get("label"), "").trim();
        if (label.isEmpty()) return label;
        List<Map<String,Object>> same = images.stream().filter(item -> label.equals(Objects.toString(item.get("label"), "").trim())).toList();
        if (same.size() < 2) return label;
        String provider = Objects.toString(model.get("provider_label"), "").trim();
        String channel = provider.isEmpty() || same.stream().filter(item -> provider.equals(Objects.toString(item.get("provider_label"), "").trim())).count() != 1
            ? Objects.toString(model.get("id"), "") : provider;
        return label + " (" + channel + ")";
    }

    public List<com.aid.model.vo.AiModelVO> filterModels(List<com.aid.model.vo.AiModelVO> models) {
        if (!"true".equals(System.getenv("GREENROOM_MANAGED"))) return models;
        List<Long> allowed = jdbc.queryForList("SELECT model_id FROM greenroom_member_models WHERE user_id=? ORDER BY sort_order", Long.class, SecurityUtils.getUserId());
        return models.stream().filter(model -> allowed.contains(model.getId()))
            .sorted(Comparator.comparingInt(model -> allowed.indexOf(model.getId()))).toList();
    }
}
