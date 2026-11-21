package com.aid.framework.security.filter;

import com.aid.common.core.domain.entity.SysUser;
import com.aid.common.core.domain.model.LoginUser;
import com.aid.core.service.ISysUserService;
import java.util.*;
import jakarta.servlet.http.HttpServletRequest;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Component;

/** The shared service is reachable only through the authenticated platform broker. */
@Component
public class GreenroomIdentity {
    private final JdbcTemplate jdbc;
    private final ISysUserService users;
    public GreenroomIdentity(JdbcTemplate jdbc, ISysUserService users) { this.jdbc=jdbc; this.users=users; }
    public synchronized LoginUser resolve(HttpServletRequest request) {
        if ("/greenroom/health".equals(request.getRequestURI())) return null;
        String member = request.getHeader("X-Greenroom-Member");
        if(member==null || member.isBlank() || member.length()>255) throw new org.springframework.security.access.AccessDeniedException("缺少平台成员身份");
        List<Long> ids=jdbc.queryForList("SELECT user_id FROM greenroom_members WHERE member_id=?",Long.class,member);
        SysUser user;
        if(ids.isEmpty()) {
            user=new SysUser();
            user.setUserName("gr_"+UUID.randomUUID().toString().replace("-","").substring(0,24));
            user.setNickName("Greenroom 成员"); user.setStatus("0"); user.setDelFlag("0");
            user.setPassword("!managed-account"); user.setCreateBy("greenroom");
            users.registerUser(user);
            jdbc.update("INSERT INTO greenroom_members(member_id,user_id) VALUES (?,?)",member,user.getUserId());
        } else user=users.selectUserById(ids.get(0));
        if(user==null || !"0".equals(user.getStatus())) throw new org.springframework.security.access.AccessDeniedException("成员账号不可用");
        return new LoginUser(user.getUserId(),user.getDeptId(),user,Set.of());
    }
}
