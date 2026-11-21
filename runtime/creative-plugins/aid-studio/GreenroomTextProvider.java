package com.aid.greenroom;
import com.aid.media.provider.*;
import com.aid.media.dto.MediaTextGenerateRequest;
import com.aid.domain.vo.AiModelConfigVo;
import com.alibaba.fastjson2.JSON;
import com.alibaba.fastjson2.JSONObject;
import java.util.*;
import java.io.IOException;
import org.springframework.stereotype.Component;
@Component
public class GreenroomTextProvider implements TextProviderClient {
    private final GreenroomQueue queue;
    public GreenroomTextProvider(GreenroomQueue queue) { this.queue=queue; }
    public String protocol() { return "greenroom-text"; }
    public void streamChat(AiModelConfigVo config,MediaTextGenerateRequest request,TextStreamCallbacks callbacks) throws IOException {
        List<Map<String,Object>> messages=TextChatOpenAiPayloadBuilder.buildMessageMaps(config,request,true);
        Map<String,Object> options=TextReasoningOptionsResolver.resolveOpenAiCompatible(config,request,request.getOptions());
        options=StructuredOutputSupport.applyJsonModeIfSupported(config,messages,options);
        Map<String,Object> body=JSON.parseObject(TextChatOpenAiPayloadBuilder.buildChatCompletionsJsonBody(config.getRealModelCode(),messages,false,options));
        String key=request.getGreenroomSubmissionId();
        if(key==null) key=request.getCallId();
        String id=queue.submit(key,"llm",request.getUserId(),body);
        for(int attempt=0;attempt<1800;attempt++) {
            JSONObject task=queue.result(id);
            if("succeeded".equals(task.getString("status"))) {
                JSONObject result=task.getJSONObject("result");
                JSONObject choice=result.getJSONArray("choices").getJSONObject(0);
                String finishError=TextFinishReasonSupport.openAiFailureMessage(choice.getString("finish_reason"));
                if(finishError!=null && !"tool_calls".equals(choice.getString("finish_reason"))) throw new IOException(finishError);
                JSONObject message=choice.getJSONObject("message");
                if(message.getString("content")!=null) callbacks.onDelta(message.getString("content"));
                if(message.containsKey("tool_calls")) {
                    MediaTextGenerateRequest.TextMessageItem item=new MediaTextGenerateRequest.TextMessageItem();item.setRole("assistant");item.setContent(message.getString("content"));
                    List<MediaTextGenerateRequest.TextToolCall> calls=new ArrayList<>();
                    for(Object raw:message.getJSONArray("tool_calls")) {
                        JSONObject call=JSON.parseObject(JSON.toJSONString(raw));JSONObject function=call.getJSONObject("function");
                        MediaTextGenerateRequest.TextToolCall mapped=new MediaTextGenerateRequest.TextToolCall();mapped.setId(call.getString("id"));mapped.setName(function.getString("name"));mapped.setArguments(function.getString("arguments"));calls.add(mapped);
                    }
                    item.setToolCalls(calls);callbacks.onToolMessage(item);
                }
                if(result.containsKey("usage")) callbacks.onUsage(result.getJSONObject("usage"));
                callbacks.onComplete(); return;
            }
            if(Set.of("failed","cancelled").contains(task.getString("status"))) throw new IOException(Objects.toString(task.get("error"),"服务商未返回具体失败原因"));
            try { Thread.sleep(1000); } catch(InterruptedException error) { Thread.currentThread().interrupt(); throw new IOException("文本任务已中断，原任务编号 "+id,error); }
        }
        throw new IOException("文本查询达到原任务时限，保留任务编号 "+id);
    }
    public ProviderTaskResult query(AiModelConfigVo config,String id) { return queue.query(id); }
}
